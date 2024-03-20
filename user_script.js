// user_script.js
document.addEventListener('DOMContentLoaded', function() {
    const startConversationButton = document.getElementById('start-conversation-btn');
    console.log('User ID:', userId); // Replace with actual user ID

    startConversationButton.addEventListener('click', async function() {
        try {
            const response = await fetch(`/user/${userId}/start-conversation`, {
                method: 'POST',
            });

            if (!response.ok) {
                throw new Error('Network response was not ok');
            }

            const result = await response.json();
            window.location.href = `/user/${userId}/${result.conversationId}`;
        } catch (error) {
            console.error('Error:', error);
        }
    });
});
