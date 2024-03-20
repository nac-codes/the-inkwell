async function updatePrewritingSection() {
    try {
        const response = await fetch(`/conversation/${conversationId}/prewriting`);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        const data = await response.json();

        // Update only the specific sections within the prewriting tab
        document.getElementById('topic').textContent = data.topic;
        document.getElementById('thesis').textContent = data.thesis;
        document.getElementById('tone').textContent = data.tone;
    } catch (error) {
        console.error('Error updating prewriting section:', error);
    }
}

async function updateConversationsList() {
    try {
         // You need to have the user's ID available, possibly embedded in the page or from user session
        const response = await fetch(`/user/${userId}/conversations`);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        const conversations = await response.json();

        const listElement = document.getElementById('conversations-list');
        listElement.innerHTML = ''; // Clear existing list items

        if (conversations.length > 0) {
            conversations.forEach(conversation => {
                const listItem = document.createElement('li');
                const link = document.createElement('a');
                link.href = `/user/${userId}/${conversation.id}`;
                link.textContent = conversation.topic || 'New Conversation';
                listItem.appendChild(link);
                listElement.appendChild(listItem);
            });
        } else {
            listElement.innerHTML = '<p>No conversations found.</p>';
        }
    } catch (error) {
        console.error('Error updating conversations list:', error);
    }
}

// Call this function when the page loads or when you need to refresh the conversations list




async function updateOutlinesSection() {
    try {
        const response = await fetch(`/conversation/${conversationId}/outlines`);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        const outlines = await response.json();

        const outlinesContainer = document.getElementById('Outline');
        outlinesContainer.innerHTML = ''; // Clear existing outlines

        outlines.forEach((outline, index) => {
            const outlineElement = document.createElement('div');
            outlineElement.classList.add('outline');

            // Title
            const titleElement = document.createElement('h3');
            titleElement.textContent = `Paragraph ${index + 1}: ${outline.title}`;
            outlineElement.appendChild(titleElement);

            // Topic
            const topicElement = document.createElement('p');
            topicElement.textContent = `Topic: ${outline.topic}`;
            outlineElement.appendChild(topicElement);

            // Subpoints
            outline.subpoints.forEach(subpoint => {
                const subpointElement = document.createElement('p');
                subpointElement.textContent = subpoint.content;
                outlineElement.appendChild(subpointElement);

                if (subpoint.quote) {
                    const quoteElement = document.createElement('blockquote');
                    quoteElement.textContent = subpoint.quote.content;
                    outlineElement.appendChild(quoteElement);

                    if (subpoint.quote.source) {
                        const sourceElement = document.createElement('p');
                        sourceElement.textContent = `Source: ${subpoint.quote.source.title || ''}, ${subpoint.quote.source.author || ''}`;
                        sourceElement.classList.add('quote-source'); // Add a class for optional styling
                        outlineElement.appendChild(sourceElement);
                    }
                }
            });

            // Conclusion
            const conclusionElement = document.createElement('p');
            conclusionElement.textContent = `Conclusion: ${outline.conclusion}`;
            outlineElement.appendChild(conclusionElement);

            outlinesContainer.appendChild(outlineElement);
        });
    } catch (error) {
        console.error('Error updating outlines section:', error);
    }
}

async function updateFinalTextSection() {
    try {
        const response = await fetch(`/conversation/${conversationId}/finaltext`);
        if (!response.ok) {
            throw new Error('Network response was not ok');
        }
        const finalTexts = await response.json();

        const finalTextContainer = document.getElementById('FinalText');
        finalTextContainer.innerHTML = ''; // Clear existing content

        // Iterate through final texts and append their content
        finalTexts.forEach(text => {
            const paragraphElement = document.createElement('p');
            paragraphElement.textContent = text;
            finalTextContainer.appendChild(paragraphElement);
        });
    } catch (error) {
        console.error('Error updating final text section:', error);
    }
}





function openTab(evt, tabName) {
    var i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("tab-content");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
    }
    tablinks = document.getElementsByClassName("tab-link");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].className = tablinks[i].className.replace(" active", "");
    }
    document.getElementById(tabName).style.display = "block";
    evt.currentTarget.className += " active";
}


// conversation_script.js
document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('chat-form');
    const userInputField = document.getElementById('user-input');
    const chatBox = document.getElementById('conversation-content');

    function scrollToBottom() {
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    

    if(document.getElementsByClassName("tab-link").length > 0) {
        document.getElementsByClassName("tab-link")[0].click();
    }

    updatePrewritingSection();
    updateOutlinesSection();
    updateFinalTextSection();
    updateConversationsList();
    

    form.addEventListener('submit', async function(event) {
        event.preventDefault();

        const userInput = userInputField.value;
        userInputField.value = ''; // Clear the input field after getting the value
        
        
        // Display the user's question
        chatBox.innerHTML += `<p>User: ${userInput}\n\n</p>`;
        scrollToBottom();

        try {
            // Send the user input to the server
            const response = await fetch('/send-message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message: userInput, conversationId: conversationId })
            });

            if (!response.ok) {
                throw new Error('Network response was not ok');
            }

            const result = await response.json();

            // Display the AI's reply
            chatBox.innerHTML += `<p>Assistant: ${result.response}</p>`;
            scrollToBottom();

            // Update the prewriting section
            updatePrewritingSection();
            updateOutlinesSection();
            updateFinalTextSection();
        } catch (error) {
            console.error('Fetch error:', error);
            chatBox.innerHTML += `<p>Error: Could not get a response from the assistant.</p>`;
        }
    });
});

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('uploadForm').addEventListener('submit', function(event) {

        const chatBox = document.getElementById('conversation-content');

        function scrollToBottom() {
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        chatBox.innerHTML += `<p>Assistant: Uploading your files and getting embeddings (this might take a while)...</p>`;
        
        event.preventDefault();
  
        var formData = new FormData(this);
        fetch('/upload', {
          method: 'POST',
          body: formData
        }).then(response => response.text())
          .then(data => {
            chatBox.innerHTML += `<p>Assistant: ${data}</p>`;
            scrollToBottom();
          })
          .catch(error => {
            console.error('Error:', error);
            chatBox.innerHTML += `<p>Error: Could not upload the file.</p>`;
          });
      });

});

