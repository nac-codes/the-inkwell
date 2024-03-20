# The Inkwell.io
http://the-inkwell.io/

## Overview

The Inkwell.io is a comprehensive essay writing assistant designed to streamline and enhance the writing process from inception to completion. This intuitive application aids users through the complex journey of essay writing by facilitating the organization of thoughts, management of sources, extraction of relevant quotes, and construction of well-structured paragraphs aligned with their central thesis. It's a tool crafted for students, researchers, and writers seeking to improve the coherence and quality of their written work.

## Features

- **Source Upload**: Users can easily upload their source materials directly into the application.
- **Quote Extraction**: Employing advanced embeddings and cosine similarity algorithms, The Inkwell extracts pertinent quotes from the uploaded source materials.
- **Writing Assistance**: The Inkwell helps users construct paragraphs that seamlessly integrate selected quotes, ensuring they align with the overarching thesis and topic.
- **Workflow Optimization**: The platform is built to assist users through their entire essay writing workflow, making the process more efficient and less daunting.

## File Structure

- `models`: Contains data models for the application, facilitating interaction with the database for users, sources, and conversations.
- `views`: Holds the EJS templates for the user interface, including the pages for user registration, login, and conversation management.
- `app.js`: The main entry point of the application which initializes and starts the web server.
- `create_embeddings_chunks.py`: A Python script used for processing source materials and creating embeddings for similarity comparison.
- `conversation_script.js`: Handles the logic for managing writing conversations within the application.
- `index.html`, `index_style.css`, `style.css`: The primary HTML and CSS files that define the layout and style of the homepage.
- `app_2_5.js`, `user_script.js`: JavaScript files containing client-side logic for user interactions.
- `search_similarities.py`: A Python script that executes the search for similarities between the user's thesis and the uploaded sources using cosine similarity.
- `chunks.npy`, `embeddings.npy`: NumPy binary files storing the pre-processed chunks and embeddings used for quote extraction.

## License

The Inkwell.io is open-source software licensed under the [MIT license](LICENSE).
