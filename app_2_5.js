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

mongoose.connect("mongodb://127.0.0.1:27017/essay_app");
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

app.post('/register', async (req, res) => {
    try {
        const hashedPassword = await bcrypt.hash(req.body.password, 10);
        const user = new User({
            username: req.body.username,
            password: hashedPassword
        });
        const newUser = await user.save();
        res.status(201).redirect('/login');
    } catch {
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

        // Create a new source object
        const newSource = new Source({
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            url: "TBD",
            title: "TBD",
            summary: "TBD",
            author: "TBD",
            publicationYear: 9999,
            publisher: "TBD",
            publicationLocation: "TBD"
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
// console.log("Conversation Object:",Conversation)

/**
 * Checks which required conversation attributes are empty.
 * @param {Object} conversation - The conversation object to check.
 * @returns {Array} - An array of missing attribute names.
 */
function getMissingAttributes(conversation) {
    const requiredAttributes = ['topic', 'thesis', 'tone', 'quotes', 'outline'];
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

                prompt += `\tQuote Content: ${quote.content}\n;`
                prompt += `\tQuote Source: ${quote.source}\n;}`
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

async function displayOriginalFilename(sourceId) {
    try {
      const source = await Source.findById(sourceId);
      if (source) {
        console.log(`Original filename: ${source.originalname}`);
        return source.originalname; // This line is optional, depending on whether you need to use the filename later in your code
      } else {
        console.log('Source not found.');
      }
    } catch (error) {
      console.error('Error fetching source:', error);
    }
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
            { id: 1, action: "Update/Edit the thesis." },
            { id: 2, action: "Update/Edit the tone." },
            { id: 3, action: "Update/Edit the topic." },
            { id: 4, action: "Remove one or more sources." },
            //{ id: 5, action: "Update/Edit the quotes." },
            { id: 6, action: "Update/Edit the outline." },
            { id: 7, action: "Generate/Create the thesis." },
            { id: 8, action: "Generate/Create the tone." },
            { id: 9, action: "Generate/Create the topic." },
            { id: 10, action: "Generate/Create the sources." },
            { id: 11, action: "Generate/Create the outline." },
            { id: 12, action: "Get/Extract quotes and add to a paragraph." },
            { id: 13, action: "Write a paragraph." },
            { id: 14, action: "Edit a paragraph." },
            { id: 15, action: "Generate/Create a bibliography." },
            { id: 16, action: "Edit the bibliography." }
        ];
        
        // Add context from rest of conversation, add the last four messages from the conversation
        
        let prompt;
        prompt += `Given the user message and the earlier conversation context, determine which actions the user wants to perform in their most recent message and return their ID or IDs in JSON format.\n`;

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

        assistantMessage = JSON.parse(assistantMessage);

        console.log("Assistant Message");
        console.log(assistantMessage);

        let log;
        for (const action of assistantMessage.user_actions) {
            let messages;
            let paragraph;
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

                    prompt = "Describe the topic the user would like for their written work based on the following input: " + req.body.message + ".\n Only return the topic.";
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
                case 5:
                    console.log("Case 5: Update/Edit the quotes.");
                    // Add logic for case 5
                    log += "This feature is under construction.\n"
                    break;
                case 6:
                    console.log("Case 6: Update/Edit the outline.");
                    // Add logic for case 6
                    log += "This feature is under construction.\n"
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
                    console.log("Case 10: Generate/Create the sources.");
                    // Add logic for case 10
                    log += "This feature is under construction.\n"
                    break;
                case 11:
                    console.log("Case 11: Generate/Create an outline for a paragraph.");
                    // Add logic for case 11
                    log += "This feature is under construction.\n"
                    break;
                case 12:
                    console.log("Add quotes to a paragraph.");
                    // Add logic for case 12
                    
                    if (conversation.paragraphs.length > 0) {
                        let paragraph_id = conversation.paragraphs[conversation.paragraphs.length - 1];
                        paragraph = await Paragraph.findById(paragraph_id);
                    } else {
                        log += "Attempted to add quotes to a paragraph but there are no paragraphs to add quotes to.\n";
                        break;
                    }

                    if (!paragraph.quotes) {
                        paragraph.quotes = true;
                    }

                    if (paragraph.outline != {}) {
                        console.log("In Paragraph Outline")


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
                                const result = await getSearchSimilarities_py(conversation.sources, subpoint.content);
                                console.log("success")
                                console.log("Python script output:", result);

                                // ask GPT to extract quote from result.chunk using getOpenAIResponse
                                prompt = "Subpoint " + subpoint.content + ";"
                                prompt += "\nText: " + result.chunk + ";"
        
                                let quote = await getOpenAIResponse([{ role: "system", content: "You are a helpful writing assistant who extracts a specific quote. You should extract a quote from the provided text related to the given subpoint. Return only the quote." }, { role: "user", content: prompt }], "gpt-4");

                                const quoteData = {
                                    source: result.file_id, // Assuming the source ID matches the file_id
                                    content: quote
                                };
                                
                                // Create a new Quote
                                const newQuote = await new Quote(quoteData).save();
                        
                                // Append the newQuote's ID to the current Subpoint
                                subpoint.quote = newQuote._id;
                                await subpoint.save();

                                let snippet = result.chunk.length > 100 ? result.chunk.substring(0, 97) + '...' : result.chunk;
                                let file_name = await displayOriginalFilename(result.file_id)

                                // Adjust the log message to include the source (file_id) and snippet of the quote content
                                log += `I found the following quotes for subpoint ${index}: Source: ${file_name}, Quote: "${snippet}".\n`;
                            } catch (error) {
                                console.error('Error executing Python script:', error);
                            }
                            
                            
                            index++;
                        }
                    
                            
                        
                    } else {
                        log += "Attempted to add quotes to a paragraph but the paragraph does not have a full outline.\n";
                        break;
                    }

                    
                    break;
                case 13:
                    console.log("Case 13: Write a paragraph.");
                    // Add logic for case 13
                    // Needs to create an outline for the paragraph, check with user, then find a related quote, check with user, then write the paragraph, check with user
                    // Should make a case  for each one and just make the check of which paragraph we're dealing with the most robust
                    
                    // check if conversation does not have any paragraphs or if the previous paragraph is already written
                    // check if outline is empty
                    // creating outline for first time

                    // determine which paragraph we are dealing with. If conversation.paragraphs.length == 0 then we are dealing with the first paragraph
                    // else if conversation.paragraphs.length > 0 then we need to check if the latest paragraph has 
                    // get length of array conversation.paragraphs
                    console.log("Conversation")
                    console.log(conversation)
                    
                    
                    if (conversation.paragraphs.length > 0) {
                        let paragraph_id = conversation.paragraphs[conversation.paragraphs.length - 1];
                        paragraph = await Paragraph.findById(paragraph_id);

                        console.log("Paragraph")
                        console.log(paragraph)
                        console.log("Paragraph Content")
                        console.log(paragraph.content)
                    }
                    

                    if (conversation.paragraphs.length == 0 || paragraph.content != "") {
                        // create a new paragraph
                        

                        // generate an outline for the paragraph
                        messages = [{ role: "system", content: "You are a helpful writing assistant who generates outlines for paragraphs. You should generate an outline for the paragraph based on the given topic and thesis. Return only the outline in JSON format." }];

                        //prompt for generating an outline based on the topic, thesis, and tone
                        // get which number paragraph we are writing
                        let n_paragraph = conversation.paragraphs.length + 1;

                        if (n_paragraph == 1) {
                            prompt = "Generate an outline for the introductory paragraph based on the topic, thesis, and tone of the whole work. Topic: " + conversation.topic + ". Thesis: " + conversation.thesis + ". Tone: " + conversation.tone + ".\n Only return the outline in JSON format using the following template.";
                        } else {
                            prompt = "Generate an outline for the #" + n_paragraph + "paragraph based on the topic, thesis, and tone of the whole work. Topic: " + conversation.topic + ". Thesis: " + conversation.thesis + ". Tone: " + conversation.tone + ".\n Only return the outline in JSON format using the following template.";
                            prompt += "Make sure that the topic of the paragraph transitions from the previous paragraph's conclusion: " + paragraph.outline.conclusion + ".\n";
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
                            return subpoint._id;  // We'll use IDs to reference subpoints in the paragraph
                        });

                        const subpointIds = await Promise.all(subpointPromises);

                        // if the paragraph is the first one then set quotes to false else set quotes to true
                        let quotes_bool = false;

                        // Step 3: Create a Paragraph Object
                        const newParagraph = new Paragraph({
                            outline: {
                                title: newOutline.title,
                                topic: newOutline.topic,
                                subpoints: subpointIds, // Reference the subpoint IDs
                                conclusion: newOutline.conclusion
                            },
                            quotes: quotes_bool,
                            content: ""
                        });
                        
                        await newParagraph.save();
                        conversation.paragraphs.push(newParagraph._id);
                        await conversation.save();

                        log += "I created a new paragraph with the following outline: " + JSON.stringify(newOutline) + ".\n";

                        // check if the paragraph quotes attribute is true
                        if (newParagraph.quotes) {
                            log += "Please let me know if the outline is sufficient and if you would like to proceed with adding quotes to it.\n";
                        } else {
                            log += "Please let me know if the outline is sufficient and if you would like to proceed with writing the paragraph.\n";
                        }

                    } else if (paragraph.content == "") {
                        // if latest paragraph does not have a a full outline with quotes, find quotes
                        // check if each subpoint of the paragraph has a quote
                        let missing_quotes = false;
                        if (paragraph.quotes) {
                            log += "This feature is under construction.\n";

                            let subpoint;
                            for (subpoint of paragraph.outline.subpoints) {
                                if (subpoint.quote == null || subpoint.quote == "") {
                                    missing_quotes = true;
                                    console.log("finding quotes...");
                                    
                                    fetch('http://34.224.173.60/search-reviews', {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                        },
                                        body: JSON.stringify({
                                            product_description: 'delicious beans',
                                            n: 3
                                        }),
                                    })
                                    .then(response => response.json())
                                    .then(data => console.log(data))
                                    .catch((error) => console.error('Error:', error));

                                } 
                            }
                        } 
                        

                        if (!missing_quotes) {
                            // write paragraph
                            console.log("Writing paragraph");

                            // feed outline to gpt-4 to write paragraph
                            // system message should include the conversation tone
                            messages = [{ role: "system", content: "You are a helpful writing assistant who writes paragraphs. You should write a paragraph based on the given outline. Use the following tone: +" + conversation.tone + "Return only the paragraph." }];

                            console.log("Outline")
                            console.log(paragraph.outline)
                            //prompt for writing a paragraph based on the outline
                            prompt = "Write a paragraph based on the following outline. Only return the paragraph:\n";

                            prompt += await getParagraphOutlineString(paragraph)
                            console.log("Prompt")
                            console.log(prompt)

                            messages.push({ role: "user", content: prompt });

                            assistantMessage = await getOpenAIResponse(messages, "gpt-4");

                            paragraph.content = assistantMessage;
                            await paragraph.save();
                            await conversation.save();

                            log += "I wrote the following paragraph: " + paragraph.content + ".\n";

                             
                        }

                        // else if latest paragraph has a full outline with quotes, write the paragraph
                        

                    } else {

                    }

                    
                    break;
                case 14:
                    console.log("Case 14: Edit a paragraph.");
                    // Add logic for case 14
                    log += "This feature is under construction.\n"
                    break;
                default:
                    console.log(`No handler for action ID: ${action.id}`);
            }
        };

        messages = [{ role: "system", content: "You are a helpful assistant that summarizes as an assitant what task you completed using the given input that summarizes what you accomplished. Be friendly but be exact in quoting from the given summary. Conclude your statement with any attributes that the user has not yet provided." }];

        // Assuming req.body.message contains the user's message
        messages.push({ role: "user", content: log });

        assistantMessage = await getOpenAIResponse(messages);

        conversation.content.push({ role: "assistant", message: assistantMessage });
        await conversation.save(); 
        
        responseMessage = assistantMessage

        res.json({ response: responseMessage });

    //     if (conversation.prewriting) {
    //         // Parse input

    //         // See what the user wants
    //         let messages = [{ role: "system", content: "You are a helpful assistant. You respond in JSON format." }];
            
    //         messages.push({ role: "user", content: "Is the user in the following message providing something related to a topic, thesis, tone, quotes, and/or outline of an essay? Yes or No?\n\n Message: " + req.body.message });
    //         console.log("Opening Q")
    //         console.log(messages)

    //         let assistantMessage = await getOpenAIResponse(messages);

    //         assistantMessage = assistantMessage.replace(/[^A-Za-z]/g, "").toLowerCase();

    //         if (assistantMessage === "yes") {
    //             console.log("The message is 'yes'");

    //             messages = [{ role: "system", content: "You are a helpful assistant. You are to return in comma-delineated fashion only which of the following categories the input is related to: topic, thesis, tone, quotes, outline." }];

    //             // Assuming req.body.message contains the user's message
    //             messages.push({ role: "user", content: req.body.message });

    //             assistantMessage = await getOpenAIResponse(messages);
            
    //             const categories = assistantMessage.split(',').map(item => item.trim());

    //             let log;
    //             for (const category of categories) {
    //                 await processCategoryWithAI(category, req.body.message, conversation);
    //                 log += "I updated the " + category + " to " + conversation[category] + ".\n";
    //             }
                
    //             const missingAttributes = getMissingAttributes(conversation);

    //             if (missingAttributes.length === 0) {
    //                 conversation.prewriting = false;
    //                 responseMessage = "Moving on to writing";
    //             } else {
    //                 log += "The user has still not provided the following attributes: " + missingAttributes.join(',') + ".";                
                    
    //                 messages = [{ role: "system", content: "You are a helpful assistant that summarizes as an assitant what task you completed using the given input that summarizes what you accomplished. Be friendly but be exact in quoting from the given summary. Conclude your statement with any attributes that the user has not yet provided." }];

    //                 // Assuming req.body.message contains the user's message
    //                 messages.push({ role: "user", content: log });

    //                 assistantMessage = await getOpenAIResponse(messages);

    //                 conversation.content.push({ role: "assistant", message: assistantMessage });
    //                 await conversation.save(); 

    //                 // Send the AI response back to the client
    //                 responseMessage = assistantMessage
    //             }

    //         } else {
    //             console.log("The message is 'no'");

    //             const missingAttributes = getMissingAttributes(conversation);

    //             messages = [
    //                 { role: "system", content: "You are a helpful writing assistant. Answer whatever questions the user has, but direct the user towards making sure that they finish their prewriting by providing the missing: " + missingAttributes.join(',') },
    //                 ...conversation.content.map(entry => {
    //                     return {
    //                         role: entry.role,
    //                         content: entry.message
    //                     };
    //                 })
    //             ];

    //             assistantMessage = await getOpenAIResponse(messages);

    //             conversation.content.push({ role: "assistant", message: assistantMessage });
    //             await conversation.save(); 

    //             responseMessage = assistantMessage
                

    //         }

            

            
    //     } else {
    //         responseMessage = "Writing under construction"
    //     }

    //     res.json({ response: responseMessage }); 

        
    //     // // Build the messages array for OpenAI, including the full conversation history
    //     // let messages = conversation.content.map(msg => ({ role: msg.role, content: msg.message }));
        
    //     // // Add the new user message to the array
    //     // messages.push({ role: "user", content: req.body.message });
    //     // conversation.content.push({ role: "user", message: req.body.message });

    //     // const assistantMessage = await getOpenAIResponse(messages);
        
    //     // conversation.content.push({ role: "assistant", message: assistantMessage });
    //     // await conversation.save();

    //     // // Send the AI response back to the client
    //     // res.json({ response: assistantMessage }); 
        
    } catch (error) {
        console.error('OpenAI or Database Error:', error);
        res.status(500).json({ error: 'Error processing your request' });
    }
});


app.post('/user/:userId/start-conversation', isAuthenticated, async (req, res) => {
    try {
        const userId = req.params.userId;
        if (req.session.userId !== userId) {
            return res.status(403).send('You are not authorized to perform this action');
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

    res.render('conversation', { user: user, conversation: conversation });

    if (user && conversation) {
        res.render('conversation', { user: user, conversation: conversation });
    } else {
        res.status(404).send('User or Conversation not found');
    }
});


// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//     console.log(`Server is running on port ${PORT}`);
// });

  

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
