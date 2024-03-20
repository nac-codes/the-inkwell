/* to do
* Error Handling at all JSON.parse 's 
* Make sure that GPT is fed the previous paragraph outline etc. in the even that there already was one and it is editing
* Add ability to change citation method (MLA APA etc)
*/




var createError = require('http-errors');
const fs = require('fs');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const session = require('express-session');
const multer = require('multer');
const pdf = require('pdf-parse');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { spawn } = require('child_process');


dotenvPath='/home/bitnami/stack/projects/sample/.env'

if (fs.existsSync(dotenvPath)) {
    console.log(`Loading environment variables from: ${dotenvPath}`);
    require('dotenv').config({ path: dotenvPath });
} else {
console.error(`.env file not found at: ${dotenvPath}`);
}


var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var app = express();

app.set('view engine', 'ejs');  // Set EJS as the view engine
app.set('views', path.join(__dirname, 'views'));  // Set the views directory

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static('/home/bitnami/htdocs'));


app.use('/', indexRouter);
app.use('/users', usersRouter);

// Database Setup
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI, { authSource: "admin" });
const db = mongoose.connection;
db.on('error', error => console.error(error));
db.once('open', () => console.log('Connected to Mongoose'));



// Logins and authentication

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

const User = require('./models/user'); // Adjust the path as per your project structure
const bcrypt = require('bcrypt');

app.get('/register', (req, res) => {
    res.render('register');
  });

const isValidEmail = (email) => {
    return /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/.test(email);
};  

app.post('/register', async (req, res) => {
    try {
        const { username, fullname, email, password } = req.body;
        if (!isValidEmail(email)) {
            return res.status(400).send('Invalid email format');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({
            username: username,
            fullname: fullname, // Add this line
            email: email, // Add this line
            password: hashedPassword
        });
        await user.save();
        res.status(201).redirect('/login');
    } catch (error) {
        console.error("Registration error:", error);
        res.status(400).redirect('/register');
    }
});

app.get('/login', (req, res) => {
    res.render('login');
  });

app.post('/login', async (req, res) => {
    try {
        // Retrieve user from the database
        const user = await User.findOne({ username: req.body.username });

        // Check if user exists and password is correct
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            // Redirect or handle the login session as per your application's needs
            req.session.userId = user._id;
            res.redirect('/user/' + user._id);
        } else {
            // Login failed
            res.status(400).send('Invalid username or password');
        }
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).send('Server error during login');
    }
});

function isAuthenticated(req, res, next) {
    if (req.session.userId) {
        return next();
    }
    res.status(401).send("You are not authorized to view this page");
}

// app.js or your main server file
app.get('/user/:userId', isAuthenticated, async (req, res) => {
    try {
        const userId = req.params.userId;
        const user = await User.findById(userId).populate('conversations');
        if (!user) {
            return res.status(404).send('User not found');
        }

        if (req.session.userId !== userId) {
            return res.status(403).send("You are not authorized to view this profile");
        } else {
            res.render('user', { user });
        }
    } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).send('Server error');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            res.status(500).send('Server error');
        }
        res.redirect('/login');  // Redirect to login page or home page
    });
});

const s3Client = new S3Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.ACCESS_KEY_ID,
      secretAccessKey: process.env.SECRET_ACCESS_KEY
    }
  });

const upload = multer({ dest: '/home/bitnami/stack/projects/sample/uploads/' });

const Source = require('./models/source');

async function get_embeddings_chunks(file_id) {
    return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', ['/home/bitnami/stack/projects/sample/create_embeddings_chunks.py', file_id]);
        
        let outputString = '';

        // Collect data from script
        pythonProcess.stdout.on('data', (data) => {
            outputString += data.toString();
        });

        // Handle script errors
        pythonProcess.stderr.on('data', (data) => {
            console.error('Python STDERR:', data.toString());
            reject(data.toString());
        });

        // Handle script exit
        pythonProcess.on('close', (code) => {
            if (code === 0) {
                try {
                    console.log(outputString);
                    resolve(outputString);
                } catch (error) {
                    reject('Error parsing output: ${error.message}');
                }
                
            } else {
                reject(`Python script exited with code ${code}`);
            }
        });
    });
}


app.post('/upload', upload.array('files'), async (req, res) => {
    const successes = [];
    const failures = [];

    // req.files will now contain an array of uploaded files
    for (const file of req.files) {
        const filePath = file.path;
        const mimeType = file.mimetype;
        console.log(file);

        if (mimeType !== 'application/pdf' && mimeType !== 'text/plain') {
            fs.unlinkSync(filePath);
            failures.push({ 
                filename: file.originalname, 
                message: 'Incorrect file type. We only accept pdf and txt.' 
            });
            continue; // Skip to the next file
        }

        let text;

        if (mimeType === 'application/pdf') {
            // Extract text from PDF
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdf(dataBuffer);
            text = pdfData.text;
        } else {
            // Read text from file
            text = fs.readFileSync(filePath, 'utf8');
        }

        // Based on a sample of the text have gpt guess the url title summary author publicationYear publisher publicationLocation have it return the json and then save the source to the database, it should return null for any that it can't find 
        prompt = "Given the text from the file, determine the source's url, title, summary, author, publicationYear, publisher, and publicationLocation. Return only the source in JSON format.\n";
        
        let json_output_example = {
            url: "TBD",
            title: "TBD",
            summary: "TBD",
            author: "TBD",
            publicationYear: 9999,
            publisher: "TBD",
            publicationLocation: "TBD"
        };
        prompt += "Base your response on the following example: " + JSON.stringify(json_output_example) + "\n";
        
        let text_sample = text;
        if (text.length > 3000) {
            text_sample = text.substring(0, 3000);
        }
        prompt += "Text: " + text_sample + "\n";

        const messages = [
            { role: "system", content: "You are a helpful assistant who helps with handling sources." },
            { role: "user", content: prompt }
        ];

        let assistantResponse = await getOpenAIResponse(messages);

        // Strip from response "```json" and "```
        assistantResponse = assistantResponse.replace("```json", "");
        assistantResponse = assistantResponse.replace("```", "");
        let response = JSON.parse(assistantResponse);

        console.log("response")
        console.log(response);

        // error handle response.publicationYear make it so that if it is a string and cannot be converted to a number then set it to 0
        if (typeof response.publicationYear === 'string') {
            try {
                response.publicationYear = parseInt(response.publicationYear);
            } catch (error) {
                response.publicationYear = 0;
            }
        }

        // Create a new source object
        const newSource = new Source({
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            url: response.url,
            title: response.title,
            summary: response.summary,
            author: response.author,
            publicationYear: response.publicationYear,
            publisher: response.publisher,
            publicationLocation: response.publicationLocation
        });

        try {
            const savedSource = await newSource.save();

            // Upload the extracted text to S3 
            const textBuffer = Buffer.from(text);
            const upload = new Upload({
                client: s3Client,
                params: {
                Bucket: 'source.files.db',
                Key: savedSource._id + ".txt",
                Body: textBuffer,
                ACL: 'private'
                }
            });

            await upload.done();

            // Add the source to the conversation
            const conversationId = req.body.conversationId;
            await Conversation.findByIdAndUpdate(
                conversationId,
                { $push: { sources: savedSource._id } },
                { new: true, useFindAndModify: false }
            );

            // Run create_embeddings_chunks.py with the source ID as input
            try {
                console.log("savedSource._id")
                console.log(savedSource._id)
                const result = await get_embeddings_chunks(savedSource._id);
                console.log(result);
            } catch (error) {
                console.error('Error:', error);
            }
        

            fs.unlinkSync(filePath); // Remove the original file after uploading to S3

            successes.push({ 
                filename: file.originalname, 
                message: 'Uploaded and processed successfully' 
            });
        } catch (uploadError) {
            console.error('Error processing file:', uploadError);
            fs.unlinkSync(filePath);
            // Consider how to handle partial failures (e.g., one file fails, others succeed)
            failures.push({ 
                filename: file.originalname, 
                message: 'Failed to process file' 
            });
        }
    }

    const formatArrayToString = (array, status) => {
        return array.map(item => `${status} - ${item.filename}: ${item.message}`).join('\n');
    };
    
    const successesString = formatArrayToString(successes, 'Success');
    const failuresString = formatArrayToString(failures, 'Failure');
    
    const fileStatusMessage = successesString + '\n' + failuresString;

    const systemInstruction = "You are a helpful assistant who helps with handling sources.";
    
    const userMessage = `First thank the user for uploading sources brielfy. Then summarize for the user what sources were succesfully uploaded and which ones weren't (if any) based on the json output provided. Do not mention the json output.`;
    const messages = [
            { role: "system", content: systemInstruction },
            { role: "user", content: fileStatusMessage },
            { role: "user", content: userMessage }
        ];
        
    const assistantResponse = await getOpenAIResponse(messages);
    
    const conversationId = req.body.conversationId;
    const conversation = await Conversation.findById(conversationId);
    conversation.content.push({ role: "assistant", message: assistantResponse });
    await conversation.save(); 


    res.send(assistantResponse);
});

  

// OpenAI setup
const OpenAI = require('openai').default;

const openai = new OpenAI();

function approximateTokenCount(message) {
    let baseTokens = 4; // Base structure of the message
    let contentTokens = message.content.length; // Roughly estimate each character as a token
    return baseTokens + contentTokens;
}

function trimMessagesToFitTokenLimit(messages, tokenLimit) {
    let totalTokens = approximateTokenCount(messages[0]); // Start with the token count of the first system message
    let trimmedMessages = [messages[0]]; // Always include the first system message

    // Start from the end and move backwards
    for (let i = messages.length - 1; i >= 1; i--) { // Start from 1 because 0 is the system message
        let messageTokenCount = approximateTokenCount(messages[i]);
        if (totalTokens + messageTokenCount <= tokenLimit) {
            totalTokens += messageTokenCount;
            trimmedMessages.push(messages[i]); // Add recent messages at the end
        } else {
            break; // Stop if adding another message exceeds the token limit
        }
    }

    // Reverse the order of added messages to maintain the original order
    
    return [trimmedMessages[0], ...trimmedMessages.slice(1).reverse()];
}


/**
 * Fetches a response from OpenAI based on the provided messages.
 * @param {Array} messages - Array of message objects with 'role' and 'content'.
 * @param {String} modelName - The OpenAI model to use, defaulting to 'gpt-3.5-turbo'.
 * @returns {Promise<String>} The response from the OpenAI assistant.
 */
async function getOpenAIResponse(messages, modelName = 'gpt-3.5-turbo') {
    try {
        
        
        messages = trimMessagesToFitTokenLimit(messages, 4000);

        const completion = await openai.chat.completions.create({
            model: modelName,
            messages: messages
        });

        const assistantMessage = completion.choices[0].message.content;
        console.log('AI Response:', assistantMessage);
        return assistantMessage;
    } catch (error) {
        console.error('Error in OpenAI API call:', error);
        throw error; // Rethrow the error for the caller to handle
    }
}

//Conversation Page
const { Conversation } = require('./models/conversation'); // Adjust the path as needed
const { Quote } = require('./models/conversation'); // Adjust the path as needed
const { Paragraph } = require('./models/conversation'); // Adjust the path as needed
const { Subpoint } = require('./models/conversation'); // Adjust the path as needed
const { create } = require('domain');
// console.log("Conversation Object:",Conversation)

async function fetchConversationDetails(conversationId) {
    // Fetch the conversation details from your database
    // Get convo
    console.log("Fetching conversation details...")
    const conversation = await Conversation.findById(conversationId);
    if (conversation) {
        return {
            topic: conversation.topic,
            thesis: conversation.thesis,
            tone: conversation.tone
        };
    }
}


app.get('/user/:userId/conversations', async (req, res) => {
    const userId = req.params.userId;
    // Make sure the current user is authorized to fetch conversations
    if (req.session.userId !== userId) {
        return res.status(403).send('Unauthorized');
    }

    try {
        // Fetch conversations for the user
        const user = await User.findById(userId).populate('conversations');

        // Check if user exists and has conversations
        if (!user || !user.conversations || user.conversations.length === 0) {
            return res.status(404).send('No conversations found');
        }

        // Step 2: Fetch each conversation by ID (assuming they're already populated)
        // If conversations are not populated, you would fetch them individually here
        // For now, we'll assume they're populated by the 'populate' call

        // Step 3: Map the conversations to a simplified format
        const simplifiedConversations = user.conversations.map(conversation => ({
            id: conversation._id,
            topic: conversation.topic || 'New Conversation'
        }));

        res.json(simplifiedConversations);

    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).send('Internal Server Error');
    }
});



// Handling and Updating Display tabs
app.get('/conversation/:conversationId/prewriting', async (req, res) => {
    const { conversationId } = req.params;
    //console.log("Updating Pre-writing Information for conversation:", conversationId)
    // Fetch the conversation details from your database
    const conversationDetails = await fetchConversationDetails(conversationId);
    if(conversationDetails) {
        res.json({
            topic: conversationDetails.topic,
            thesis: conversationDetails.thesis,
            tone: conversationDetails.tone
        });
    } else {
        console.log("Conversation not found");
    }
});

app.get('/conversation/:conversationId/outlines', async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.conversationId)
            .populate({
                path: 'paragraphs',
                model: 'Paragraph', // Explicitly specifying the model to use for population
                populate: {
                    path: 'outline.subpoints',
                    model: 'Subpoint', // Explicitly specifying the model to use for population
                    populate: {
                        path: 'quote',
                        model: 'Quote', // Explicitly specifying the model for the quote
                        populate: {
                            path: 'source', // Populate the source field in the Quote document
                            model: 'Source' // Assuming 'Source' is the correct model name for your source documents
                        }
                    }
                }
            });

        if (!conversation) {
            return res.status(404).send('Conversation not found');
        }

        // Extract and send just the outlines if that's all you need
        const outlines = conversation.paragraphs.map(paragraph => paragraph.outline);
        res.json(outlines);
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});


app.get('/conversation/:conversationId/finaltext', async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.conversationId)
            .populate('paragraphs') // Ensure paragraphs are populated
            .exec(); // Execute the query

        if (!conversation) {
            return res.status(404).send('Conversation not found');
        }

        // Extract the content from each paragraph and send it as an array
        const finalTexts = conversation.paragraphs.map(paragraph => paragraph.content);
        res.json(finalTexts); // Send back the array of paragraph contents
    } catch (error) {
        console.error(error);
        res.status(500).send('Server error');
    }
});



/**
 * Checks which required conversation attributes are empty.
 * @param {Object} conversation - The conversation object to check.
 * @returns {Array} - An array of missing attribute names.
 */
function getMissingAttributes(conversation) {
    const requiredAttributes = ['topic', 'thesis', 'tone'];
    let missingAttributes = [];

    for (const attr of requiredAttributes) {
        if (!(attr in conversation) || conversation[attr] === undefined || conversation[attr] === null || conversation[attr] === '' || (Array.isArray(conversation[attr]) && conversation[attr].length === 0)) {
            missingAttributes.push(attr); // Attribute is missing or empty
        }
    }

    return missingAttributes;
}

async function getParagraphOutlineString(paragraph) {
    let prompt = "";

    if (!paragraph || !paragraph.outline) {
        return "Invalid paragraph or outline.";
    }

    // Append Title
    prompt += "Title: " + paragraph.outline.title + "\n";

    // Append Topic
    prompt += "Topic: " + paragraph.outline.topic + "\n";

    // Append Subpoints and Quotes
    if (paragraph.outline.subpoints && paragraph.outline.subpoints.length > 0) {
        prompt += "Subpoints:\n";
        let subpoint;
        let quote;
        let index = 1;
        // loop trhough subpoint ids array in paragraph.outline
        for (const subpoint_id of paragraph.outline.subpoints) {
            // get subpoint object from subpoint id
            subpoint = await Subpoint.findById(subpoint_id);
            console.log("Subpoint")
            console.log(subpoint)
            // append subpoint content to prompt
            prompt += `  Subpoint ${index + 1}: ${subpoint.content}\n`;
            // check if subpoint has a quote
            if (subpoint.quote) {
                // Append Quote details, assuming the quote is populated
                quote = await Quote.findById(subpoint.quote);
                console.log("Quote")
                console.log(quote)

                let title_author = await getTitle_Author(quote.source);

                prompt += `\tQuote Content: ${quote.content}\n;`
                prompt += `\tQuote Source: ${title_author}\n;}`
            }
            index++;
        }

        
    } else {
        prompt += "No subpoints available.\n";
    }


    // Append Conclusion
    prompt += "Conclusion: " + paragraph.outline.conclusion + "\n";
    
    return prompt;
}

// Run Python Script Function
async function getSearchSimilarities_py(fileIds, search_string) {
    return new Promise((resolve, reject) => {
        const fileIdsString = fileIds.join(',');
        const pythonProcess = spawn('python', ['/home/bitnami/stack/projects/sample/search_similarities.py', fileIdsString, search_string]);
        
        let outputData = '';

        // Collect data from script
        pythonProcess.stdout.on('data', (data) => {
            console.log("data")
            console.log(data);
            outputData += data.toString();
            console.log("outputData")
            console.log(outputData);
        });

        // Handle script errors
        pythonProcess.stderr.on('data', (data) => {
            reject(data.toString());
        });

        // Handle script exit
        pythonProcess.on('close', (code) => {
            if (code === 0) {
                try {
                    const parsedOutput = JSON.parse(outputData);
                    resolve(parsedOutput);
                } catch (error) {
                    reject('Error parsing output: ${error.message}');
                }
                
            } else {
                reject(`Python script exited with code ${code}`);
            }
        });
    });
}

// Change this to getTitle_Author that gets the source title and author
async function getTitle_Author(sourceId) {
    try {
      const source = await Source.findById(sourceId);
      if (source) {
        // Check if the source has a title and author if not get them
        // console.log(`Original filename: ${source.originalname}`);
        let title_author = "";
        if (source.title != "TBD" && source.title != "Unkonwn") {
            title_author = source.title + " by " + source.author;
        }
        
        return title_author; 
      } else {
        console.log('Source not found.');
        return "";
      }
    } catch (error) {
      console.error('Error fetching source:', error);
    }
}

// Function to create a new empty paragraph object
async function createParagraph(conversation) {
    let quotes_bool = false;

    // Step 3: Create a Paragraph Object
    const newParagraph = new Paragraph({
        outline: {},
        quotes: quotes_bool,
        content: ""
    });
    
    await newParagraph.save();
    conversation.paragraphs.push(newParagraph._id);
    await conversation.save();
    return newParagraph._id.toString();
}

// Function to determine which paragraph the user wants to interact with
async function whichParagraph(conversation, userInput) {

    let paragraph_id; 

    if (conversation.paragraphs.length > 0) {
        paragraph_id = conversation.paragraphs[conversation.paragraphs.length - 1].toString();
        // ask GPT which paragraph out of the conversation.paragraph list the user seems to be referring to based on the user input using getOpenAIResponse
        let prompt = "Given the user message, determine which paragraph the user wants to interact with based on the user input and return only the paragraph ID.";
        // add conversation context of the past couple user messages
        prompt += `Conversation context: ${conversation.content.slice(-4, -1).map(entry => entry.message).join('\n')}\n`;

        prompt += "User message: " + userInput + "\n\n";
        
        // Add a stringified list of all the paragraphs to the prompt with the topic of each paragraph populated
        let paragraph;
        for (const paragraph_id of conversation.paragraphs) {
            paragraph = await Paragraph
                .findById(paragraph_id)
                .populate('outline');
            prompt += `ID: ${paragraph._id}, Topic: ${paragraph.outline.topic}\n`;
        }
        let messages = [{ role: "system", content: "You are a helpful assistant. You should determine which paragraph the user wants to interact with based on the user input and return only the paragraph_id in json format. If you're not sure then reply with the last paragraph." }, { role: "user", content: prompt }];

        console.log("messages");
        console.log(messages);

        let assistantMessage = await getOpenAIResponse(messages, "gpt-4");
        // extract paragraph_id from assistantMessage that is in JSON format
        try {
            assistantMessage = JSON.parse(assistantMessage);
            paragraph_id = assistantMessage.paragraph_id;
        } catch (error) {
            console.error('Error parsing JSON:', error);
        }
        //console.log(paragraph_id);

        return paragraph_id;
    } else {
        paragraph_id = await createParagraph(conversation);
        return paragraph_id;
    }
}

// Function to create a new outline with params paragraph_id and optional param custom instructions
async function createOutline(paragraph_id, conversation, custom_instructions = "") {
    let log = "Working on Outline...\n";
    messages = [{ role: "system", content: "You are a helpful writing assistant who generates outlines for paragraphs. You should generate an outline for the paragraph based on the given topic and thesis. Return only the outline in JSON format." }];

    const paragraph = await Paragraph.findById(paragraph_id);

    // Get which paragraph it is from the conversation.paragraphs list
    let n_paragraph;
    for (n_paragraph = 0; n_paragraph < conversation.paragraphs.length; n_paragraph++) {
        if (conversation.paragraphs[n_paragraph].toString() === paragraph_id) {
            break;
        }
    }
    n_paragraph++;

    // Check if the conversation has a thesis topic and tone
    let missingAttributes = getMissingAttributes(conversation);
    if (missingAttributes.length > 0) {
        log += "The conversation is missing the following attributes. Please request the user create them before starting an outline: " + missingAttributes.join(', ') + ".\n";
        return log;
    }


    if (n_paragraph == 1) {
        if (custom_instructions != "") {
            prompt = "Generate an outline for the introductory paragraph based on the topic, thesis, and tone of the whole work. Topic: " + conversation.topic + ". Thesis: " + conversation.thesis + ". Tone: " + conversation.tone + ".\n"
            prompt += "Your outline should be based on the following instructions: " + custom_instructions + "\n";
            prompt += "Only return the outline in JSON format using the following template.";
        } else {
            prompt = "Generate an outline for the introductory paragraph based on the topic, thesis, and tone of the whole work. Topic: " + conversation.topic + ". Thesis: " + conversation.thesis + ". Tone: " + conversation.tone + ".\n Only return the outline in JSON format using the following template.";
        }
        
    } else {
        prompt = "Generate an outline for the #" + n_paragraph + "paragraph based on the topic, thesis, and tone of the whole work. Topic: " + conversation.topic + ". Thesis: " + conversation.thesis + ". Tone: " + conversation.tone + ".\n";
            // Add to the prompt the paragraphs that we have so far with their topics
        let prev_paragraph;
        let index = 0;
        for (const pd_id of conversation.paragraphs) {
            if (index == n_paragraph - 1) {
                break;
            }
            prev_paragraph = await Paragraph
                .findById(pd_id)
                .populate('outline');
            prompt += `Paragraph #: ${index+1}, Topic: ${prev_paragraph.outline.topic}\n`;
            index++;
        }
        
        if (custom_instructions != "") {
            prompt += "Your outline should be based on the following instructions: " + custom_instructions + "\n";
        } else {
            prompt = "Generate an outline for the #" + n_paragraph + "paragraph based on the topic, thesis, and tone of the whole work. Topic: " + conversation.topic + ". Thesis: " + conversation.thesis + ". Tone: " + conversation.tone + ".\n"
        }

        prompt += "Make sure that the topic of the paragraph transitions from the previous paragraph's conclusion: " + paragraph.outline.conclusion + ".\n";
        prompt += "Only return the outline in JSON format using the following template:\n";
    }
    

    //add the template for the outline schema specify that the outline should not include quotes at this stage, template should have n number of subpoints based on a n_subpoints variable equal to 3 as default
    let n_subpoints = 3;
    let outlineTemplate = {
        title: "[Title Placeholder]", // Placeholder for the title
        topic: "[Topic Placeholder]", // Placeholder for the main topic
        subpoints: [],
        conclusion: "[Conclusion Placeholder]" // Placeholder for the conclusion
    };

    // Generating subpoints
    for (let i = 1; i <= n_subpoints; i++) {
        outlineTemplate.subpoints.push({
            content: `Subpoint ${i} Placeholder` // Placeholder for each subpoint
        });
    }

    prompt += JSON.stringify(outlineTemplate);

    console.log("Prompt")
    console.log(prompt)

    messages.push({ role: "user", content: prompt });

    assistantMessage = await getOpenAIResponse(messages, "gpt-4");

    try {
        const newOutline = JSON.parse(assistantMessage);

        console.log("Assistant Outline Parsed");
        console.log(newOutline);

        // Step 2: Create Subpoint Objects
        const subpointPromises = newOutline.subpoints.map(async subpointData => {
            const subpoint = new Subpoint({
                content: subpointData.content,
                quote: null
            });
            await subpoint.save();
            return subpoint._id;  
        });

        const subpointIds = await Promise.all(subpointPromises);

        // if the paragraph is the first one then set quotes to false else set quotes to true
        let quotes_bool = false;

        // Step 3: Create a Paragraph Object
        paragraph.outline = {
            title: newOutline.title,
            topic: newOutline.topic,
            subpoints: subpointIds, 
            conclusion: newOutline.conclusion
        };
        paragraph.quotes = quotes_bool;
        paragraph.content = "";
        
        await paragraph.save();

        log += "I created an outline for paragraph " + n_paragraph + " with the following outline: " + JSON.stringify(newOutline) + ".\n";

        // check if the paragraph quotes attribute is true
        if (conversation.sources.length > 0) {
            log += "Ask the user if the outline is sufficient and if they would like to proceed with adding quotes to it or would like me to move onto to writing the paragraph.\n";
        } else {
            log += "Ask the user if the outline is sufficient and if they would like me to proceed with writing the paragraph.\n";
        }


    } catch (error) {
        console.error('Error parsing JSON:', error);
        log += "I was unable to generate an outline for paragraph. " + n_paragraph + "\n";
    }
    
    return log;
    
}

// function to get quotes
async function getQuotes(paragraph_id, conversation, convo_sources_only=true) {
    const paragraph = await Paragraph 
        .findById(paragraph_id)
        .populate('outline');

    let log = "Working on Quotes...\n";
    
    if (!paragraph.quotes) {
        paragraph.quotes = true;
        await paragraph.save();
    }
    
    if (paragraph.outline != {}) {
        let subpoint;
        let index = 1;
        // loop trhough subpoint ids array in paragraph.outline
        for (const subpoint_id of paragraph.outline.subpoints) {
            // get subpoint object from subpoint id
            subpoint = await Subpoint.findById(subpoint_id);
            console.log("Subpoint")
            console.log(subpoint.content)
    
            // Run the Python script with the input
            try {
                let result;
                if (convo_sources_only) {
                    result = await getSearchSimilarities_py(conversation.sources, subpoint.content);
                } else {
                    // Get quotes from all sources
                    result = {};
                    log += "Feature under construction \n";
                }
                
                
                //console.log("success");
                //console.log("Python script output:", result);
    
                // ask GPT to extract quote from result.chunk using getOpenAIResponse
                prompt = "Extract a quote from the given text related to the given subpoint. Return only the quote.\n";
                prompt += "Subpoint " + subpoint.content + ";\n";
                prompt += "\nText: " + result.chunk + ";";
    
                let quote = await getOpenAIResponse([{ role: "system", content: "You are a helpful writing assistant who extracts a specific quote. You should extract a quote from the provided text related to the given subpoint. Return only the quote. If you can't find a quote then return an empty string" }, { role: "user", content: prompt }], "gpt-4");
                
                if (quote != "\"\"") {
                    const quoteData = {
                        source: result.file_id, 
                        content: quote
                    };
                    
                    // Create a new Quote
                    const newQuote = await new Quote(quoteData).save();
            
                    // Append the newQuote's ID to the current Subpoint
                    subpoint.quote = newQuote._id;
                    await subpoint.save();
        
                    let sourceName = await getTitle_Author(result.file_id);
                    
        
                    
                    
                    log += `I found the following quotes for subpoint ${index}: Source: ${sourceName}, Quote: "${quote}".\n`;
                } else {
                    log += `I was unable to find an adequete quote for subpoint ${index}.\n`;
                }
            } catch (error) {
                console.error('Error executing Python script:', error);
                log += "I was unable to find quotes for subpoint " + index + ".\n";
            }
            
            
            index++;
        }

        log += "Now that we have the quotes for the paragraph, ask the user if they would like to proceed with writing the paragraph.\n";
    
    } else {
        log += "Attempted to add quotes to a paragraph but the paragraph does not have a full outline.\n";
    }

    
    
    return log;

}

// function to write a paragaph
async function writeParagraph(paragraph_id, conversation, custom_instructions = "") {
    let log = "";
    
    const paragraph = await Paragraph
        .findById(paragraph_id)
        .populate('outline');
    
    
    messages = [{ role: "system", content: "You are a helpful writing assistant who writes paragraphs. You should write a paragraph based on the given outline. Cite the sources for any quotes that you use. Use the following tone: +" + conversation.tone + "Return only the paragraph." }];

    console.log("Outline")
    console.log(paragraph.outline)
    //prompt for writing a paragraph based on the outline
    let prompt = "Write a paragraph based on the following outline. Only return the paragraph.\n";
    prompt += "Consider the following instructions: " + custom_instructions + "\n";

    prompt += await getParagraphOutlineString(paragraph)
    console.log("Prompt")
    console.log(prompt)

    messages.push({ role: "user", content: prompt });

    assistantMessage = await getOpenAIResponse(messages, "gpt-4");

    paragraph.content = assistantMessage;
    await paragraph.save();
    

    log += "I wrote the following paragraph: " + paragraph.content + ".\n";

    log += "Ask the user if they would like to proceed with editing the paragraph or if they would like to proceed with creating an outline for the next paragraph.\n";

    return log;    

}


// Add the OpenAI route
app.post('/send-message', async (req, res) => {
    try {
        // Retrieve the conversation ID from the request
        const conversationId = req.body.conversationId;
        if (!conversationId) {
            return res.status(400).send('Conversation ID not provided');
        }

        // Fetch the conversation from the database
        
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            return res.status(404).send('Conversation not found');
        }

        conversation.content.push({ role: "user", message: req.body.message });

        let responseMessage;

        const userActions = [
            { id: 1, action: "Update/Edit/Create the thesis." },
            { id: 2, action: "Update/Edit/Create the tone." },
            { id: 3, action: "Update/Edit/Create the topic." },
            { id: 4, action: "Remove one or more sources." },
            //{ id: 7, action: "Generate/Create the thesis." },
            //{ id: 8, action: "Generate/Create the tone." },
            //{ id: 9, action: "Get quotes and add to a paragraph" },
            { id: 10, action: "Edit the outline of an existing paragraph." },
            { id: 11, action: "Create an outline for a new/the next paragraph." },
            { id: 12, action: "Get quotes and add to a paragraph." },
            { id: 13, action: "Write/edit a paragraph." },
            { id: 14, action: "The user has a question about the writing process."}
            //{ id: 15, action: "Create/Edit a bibliography." },
            // Generate sources
            // Get quotes from all sources (not just those uploaded)
        ];
        
        // Add context from rest of conversation, add the last four messages from the conversation
        
        let prompt;
        prompt += `Given the latest user message and the earlier conversation context, determine which actions the user wants to perform in their most recent message and return their ID or IDs in JSON format. If none of the listed actions are applicable return 'id: 0' ;\n`;

        // add the conversation context to the prompt of the last four messages before the latest one
        prompt += `Conversation context: ${conversation.content.slice(-4, -1).map(entry => entry.message).join('\n')}\n`;
        prompt += `User message: ${req.body.message}\n`;

        prompt += "Here is a list of possible user actions and their IDs:\n";
        userActions.forEach(action => {
            prompt += `ID: ${action.id}, Action: ${action.action}\n`;
        });

        
        console.log("Prompt")
        console.log(prompt)


        let json_example = JSON.stringify({
            user_actions: [
              { id: 3, action: 'Update/Edit the topic' },
              { id: 12, action: 'Get/Extract quotes from a specific source or sources' }
            ]
          });

        let messages = [{ role: "system", content: "You are a helpful assistant. You respond in JSON format like in the following example: " + json_example }];
            
        messages.push({ role: "user", content: prompt });
        console.log("Opening Q")
        console.log(messages)

        let assistantMessage = await getOpenAIResponse(messages, "gpt-4");

        let log = "Original user message: " + req.body.message + ".\n";

        // Add error handling here, in case user message none of the above
        try {
            assistantMessage = JSON.parse(assistantMessage);
        } catch (error) {
            console.error('Error parsing JSON:', error);
            assistantMessage = { user_actions: [] };
            log += "I was unable to determine the user's action from their message.\n";
        }
        

        console.log("Assistant Message");
        console.log(assistantMessage);

        // make of list of the id's within assistantMessage.user_actions
        let user_actions_ids = [];
        for (const action of assistantMessage.user_actions) {
            user_actions_ids.push(action.id);
        }

        if (user_actions_ids.includes(14)) {
            console.log("Case 14: The user has a question about the writing process.");
            
            log += "Try to answer the user's question based on the following information\n";
            log += "User message: " + req.body.message + "\n";

            log += "Explain to the user the writing process and how you can help them with it.\n";
            log += "The user should first create a topic, thesis, and tone. Then they may proceed with creating an outline for the first paragraph. After that, they can add quotes to the paragraph and then write the paragraph. They can then proceed with editing the paragraph or creating an outline for the next paragraph.\n";

            log += "Here are some possible actions the user can take: \n";
            userActions.forEach(action => {
                log += `Action: ${action.action}\n`;
            });
        } else {
            for (const action of assistantMessage.user_actions) {
                let messages;
                let paragraph_id;
                switch (action.id) {
                    case 1:
                        console.log("Case 1: Update/Edit the thesis.");
                        
                        messages = [{ role: "system", content: "You are a helpful writing assistant who composes thesis statements. Here are some basic guidelines for writing a thesis: Clearly state your position by expressing your main argument directly and specifically, make it debatable to invite challenges and disagreements, keep it focused and narrow enough for thorough exploration within your essay, ensure it reflects the type of paper you're writing, use strong and assertive language to show conviction, address and refute a counterargument to enhance credibility, and be concise as a thesis statement should be a one or two sentence summary of your argument." }];
    
                        prompt = "Compose a thesis statement based on the user's input: " + req.body.message + ".\n Only return the thesis statement.";
                        if (conversation.thesis) {
                            prompt += "\nAlso consider the previous thesis statement but prioritize the user input: " + conversation.thesis + ".";
                        }
    
                        messages.push({ role: "user", content: prompt });
    
                        assistantMessage = await getOpenAIResponse(messages, "gpt-4");
    
                        conversation.thesis = assistantMessage;
                        await conversation.save(); 
    
                        log += "I updated the thesis to " + conversation.thesis + ".\n";
                        break;
                    case 2:
                        console.log("Case 2: Update/Edit the tone.");
                        // Add logic for updating/editing the tone
                        messages = [{ role: "system", content: "You are a helpful writing assistant who describes the tone of a written work. " }];
    
                        prompt = "Describe the tone the user would like for their written work based on the following input: " + req.body.message + ".\n Only return the tone.";
                        if (conversation.tone) {
                            prompt += "\nAlso consider the previous tone but prioritize the user input: " + conversation.tone + ".";
                        }
                        
    
                        messages.push({ role: "user", content: prompt });
    
                        assistantMessage = await getOpenAIResponse(messages, "gpt-4");
    
                        conversation.tone = assistantMessage;
                        await conversation.save(); 
    
                        log += "I updated the tone to " + conversation.tone + ".\n";
    
                        break;
                    case 3:
                        console.log("Case 3: Update/Edit the topic.");
                        // Add logic for case 3
                        messages = [{ role: "system", content: "You are a helpful writing assistant who describes the topic of a written work. " }];
    
                        prompt = "Create the topic the user would like for their written work based on the following input: " + req.body.message + ".\n Only return the topic. Keep it concise like a title.";
                        if (conversation.topic) {
                            prompt += "\nAlso consider the previous topic but prioritize the user input: " + conversation.topic + ".";
                        }
    
                        messages.push({ role: "user", content: prompt });
    
                        assistantMessage = await getOpenAIResponse(messages, "gpt-4");
    
                        conversation.topic = assistantMessage;
                        await conversation.save();
    
                        log += "I updated the topic to " + conversation.topic + ".\n";
                        break;
                    case 4:
                        console.log("Case 4: Remove one or more sources.");
                        // Add logic for case 4
                        //Add other cases for dealing with sources
                        //messages = [{ role: "system", content: "You are a helpful assistant. You respond in JSON format like in the following example: " + json_example }];
                        //check if conversation has any sources
                        if (conversation.sources.length > 0) {
                            messages = [{ role: "system", content: "You are a helpful writing assistant who handles sources. You should identify which sources the user wants removed based on the provided list. Return only the JSON in the following format: {\"source_ids_to_remove\": [\"65a02bb7689e0366ecbc41f2\"]}" }];
    
                            prompt = "Which source(s) would the user like to remove. Return only the source IDs of ones they want removed. Possible sources: \n"
                            let source;
                            for (const sourceID of conversation.sources) {
                                console.log("Source ID")
                                console.log(sourceID)
                                source = await Source.findById(sourceID);
                                console.log("Source")
                                console.log(source)
                                if (!source) {
                                    return res.status(404).send('Source not found');
                                }
                                prompt += `ID: ${source._id}, Source: ${source.originalname}\n`;
                                log += "I removed the following source: " + source.originalname + ".\n";
                            };
    
                            prompt += "Original user message: " + req.body.message;
                            
                            console.log("Prompt")
                            console.log(prompt)
    
                            messages.push({ role: "user", content: prompt });
    
                            assistantMessage = await getOpenAIResponse(messages, "gpt-4");
    
                            assistantMessage = JSON.parse(assistantMessage);
    
                            console.log("Assistant Message");
                            console.log(assistantMessage);
    
                            //check if assistantMessage has any sources to remove
                            if (assistantMessage.source_ids_to_remove.length > 0) {
                                //remove sources from conversation
                                for (const sourceID of assistantMessage.source_ids_to_remove) {
                                    conversation.sources.pull(sourceID);
                                    await conversation.save(); 
                                }
                                
                                //conversation.sources = assistantMessage;
                                //await conversation.save(); 
    
                                
                            } else {
                                log += "Attempted to remove a source but the source you are describing was not found.\n";
                            }
                            
    
                            
                        } else {
                            log += "Attempted to remove a source but there are no sources to remove.\n";
                        }
    
                        
                        break;
                    case 7:
                        console.log("Case 7: Generate/Create the thesis.");
                        // Add logic for case 7
                        log += "This feature is under construction.\n"
                        break;
                    case 8:
                        console.log("Case 8: Generate/Create the tone.");
                        // Add logic for case 8
                        log += "This feature is under construction.\n"
                        break;
                    case 9:
                        console.log("Case 9: Generate/Create the topic.");
                        // Add logic for case 9
                        log += "This feature is under construction.\n"
                        break;
                    case 10:
                        console.log("Case 10: Edit the outline of an existing paragraph.");
                        // Add logic for case 10
                        paragraph_id = await whichParagraph(conversation, req.body.message);
    
                        log += await createOutline(paragraph_id, conversation, custom_instructions = req.body.message);
                        
                        break;
                    case 11:
                        console.log("Case 11: Create/edit an outline for the next paragraph.");
                        
                        paragraph_id = await createParagraph(conversation);  
                        // get which paragraph we are writing
    
                        log += await createOutline(paragraph_id, conversation, custom_instructions = req.body.message);
                        
                        break;
                    case 12:
                        console.log("Add quotes to a paragraph.");
                        // Add logic for case 12
    
                        // get which paragraph we are writing
                        
    
                        paragraph_id = await whichParagraph(conversation, req.body.message);
                        
            
                        log += await getQuotes(paragraph_id, conversation, convo_sources_only = true);
                    
                        break;
                    case 13:
                        console.log("Case 13: Write/edit a paragraph.");
                        
                        // get which paragraph we are writing
    
                        
                        paragraph_id = await whichParagraph(conversation, req.body.message);
    
                        const paragraph = await Paragraph
                            .findById(paragraph_id)
                            .populate('outline');
    
                        if (paragraph.outline == {}) {
                            // Replace with log please create a new paragraph and generate an outline for it first
                            log += "Ask the user to first create an outline for paragraph: " + paragraph_id + ".\n";
                            break;
                        }
    
                        log += await writeParagraph(paragraph_id, conversation, req.body.message);
                        
                        break;
                  
                    default:
                        console.log(`No handler for action ID: ${action.id}`);
                        log += "I was unable to determine the user's action from their message. Ask them to ask me to do something related to helping them write.\n";
                        
                        // provide a series of possible actions that the user can take
                        log += "Here are some possible actions the user can take: \n";
                        userActions.forEach(action => {
                            log += `Action: ${action.action}\n`;
                        });
    
                        break
                }
            };
        }
       

        messages = [{ role: "system", content: "You are a helpful assistant that summarizes as an assitant what task you completed using the given input that summarizes what you accomplished. Be friendly but be exact in quoting from the given summary. Conclude your statement with any attributes that the user has not yet provided." }];

        
        // Assuming req.body.message contains the user's message
        messages.push({ role: "user", content: log });

        assistantMessage = await getOpenAIResponse(messages);

        conversation.content.push({ role: "assistant", message: assistantMessage });
        await conversation.save(); 
        
        responseMessage = assistantMessage

        res.json({ response: responseMessage });

        
    } catch (error) {
        console.error('OpenAI or Database Error:', error);
        res.status(500).json({ error: 'Error processing your request' });
    }
});


app.post('/user/:userId/start-conversation', isAuthenticated, async (req, res) => {
    try {
        const userId = req.params.userId;
        if (req.session.userId !== userId) {
            return res.redirect('/login');
        }
        
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).send('User not found');
        }


        const newConversation = new Conversation({
            userId: userId,  // Convert to MongoDB ObjectId
            content: [],                              // Starting with an empty conversation
            topic: '',                                // Blank topic
            thesis: '',                               // Blank thesis
            writing_instructions: '',                 // Blank writing instructions
            quotes: [],                               // Empty array for quotes
            outline: []                               // Empty array for the outline
        });

        await newConversation.save();

        user.conversations.push(newConversation._id);
        await user.save();

        res.status(200).json({ conversationId: newConversation._id });
    } catch (error) {
        console.error('Error creating new conversation:', error);
        res.status(500).send('Error creating new conversation');
    }
});

app.get('/user/:userId/:conversationId', async (req, res) => {
    const userId = req.params.userId;
    if (req.session.userId !== userId) {
        return res.status(403).send('You are not authorized to perform this action');
    }
    const conversationId = req.params.conversationId;

    const user = await User.findById(userId);
    const conversation = await Conversation.findById(conversationId);

   

    if (user && conversation) {
        res.render('conversation', { user: user, conversation: conversation });
    } else {
        res.status(404).send('User or Conversation not found');
    }
});






  

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
