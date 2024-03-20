import sys
import json
from openai import OpenAI
import pandas as pd
client = OpenAI()
import tiktoken
import numpy as np
import os
from scipy.spatial.distance import cosine
import boto3
from botocore.exceptions import ClientError

dotenv_path = os.path.join(os.path.dirname(__file__), '.env')

# Set environment variables
aws_access_key_id = os.getenv('AWS_ACCESS_KEY_ID')
aws_secret_access_key = os.getenv('AWS_SECRET_ACCESS_KEY')




def download_file_from_s3(bucket_name, s3_key, local_file_name):
    s3 = boto3.client('s3')
    s3.download_file(bucket_name, s3_key, local_file_name)

def file_exists_in_s3(bucket_name, s3_key):
    s3 = boto3.client('s3')
    try:
        s3.head_object(Bucket=bucket_name, Key=s3_key)
        return True
    except ClientError as e:
        # The file does not exist if the error code is 404
        if e.response['Error']['Code'] == '404':
            return False
        else:
            raise

def upload_file_to_s3(bucket_name, s3_key, local_file_name):
    s3 = boto3.client('s3')
    s3.upload_file(local_file_name, bucket_name, s3_key)


# From https://github.com/openai/openai-python/blob/release-v0.28.0/openai/embeddings_utils.py
def cosine_similarity(a, b):
    """Calculate the cosine similarity between two vectors."""
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def get_embedding(text, model="text-embedding-ada-002"):
   text = text.replace("\n", " ")
   return client.embeddings.create(input = [text], model=model).data[0].embedding

def preprocess_text(text):
    if pd.isna(text):
        return ""  # Return an empty string for NaN values
    # Example preprocessing steps
    text = text.replace("\n", " ")  # Replace newlines with spaces
    text = text.strip()  # Remove leading and trailing whitespace
    # Add any other preprocessing steps here
    return text

def get_chunks(text, encoding, max_tokens=8000, target_chunk_len=500, buffer=None, recalc_interval=1000):
    words = text.split()
    chunks = []
    current_chunk = []
    estimated_tokens = 0
    word_count = 0

    if (buffer is None):
        buffer = 0.2*max_tokens

    initial_sample_text = ' '.join(words[:min(recalc_interval, len(words))])
    initial_sample_encoded = encoding.encode(initial_sample_text)
    avg_tokens_per_word = len(initial_sample_encoded) / max(1, len(initial_sample_text.split()))

    for word in words:
        current_chunk.append(word)
        word_count += 1
        estimated_tokens += avg_tokens_per_word

        if word_count % recalc_interval == 0 and word_count + recalc_interval <= len(words):
            next_batch_end = min(word_count + recalc_interval, len(words))
            sample_text = ' '.join(words[word_count:next_batch_end])
            sample_encoded = encoding.encode(sample_text)
            avg_tokens_per_word = len(sample_encoded) / len(sample_text.split())
            #print(f"Adjusted average tokens per word: {avg_tokens_per_word:.2f}")

        # Check if the estimated token count exceeds max_tokens
        if estimated_tokens > max_tokens - buffer or len(current_chunk) >= target_chunk_len:
            if estimated_tokens > max_tokens - buffer:
                current_chunk.pop()  # Remove the last word if max_tokens exceeded
                estimated_tokens -= avg_tokens_per_word
            chunks.append(' '.join(current_chunk))
            current_chunk = []
            estimated_tokens = 0

    if current_chunk:
        chunks.append(' '.join(current_chunk))

    return chunks


def get_search_hits(embeddings, chunks, search_term, n=3):
    search_embedding = get_embedding(search_term, model='text-embedding-ada-002')

    # if not all(isinstance(emb, (list, np.ndarray)) and len(np.shape(emb)) == 1 for emb in embeddings):
    #     raise ValueError("All embeddings must be 1-D lists or arrays.")

    # Calculate cosine similarities

    flattened_embeddings = []
    for i, emb in enumerate(embeddings):
        if np.ndim(emb) > 1:
            #print(f"Flattening non-1-D embedding at index {i}.")
            emb = emb.flatten()
        flattened_embeddings.append(emb)


    #flattened_embeddings = [emb.flatten() if np.ndim(emb) > 1 else emb for emb in embeddings]
    flattened_search_embedding = search_embedding.flatten() if np.ndim(search_embedding) > 1 else search_embedding

    similarities = [cosine_similarity(flattened_search_embedding, emb) for emb in flattened_embeddings]
  

    # Get top n similar embeddings
    top_indices = sorted(range(len(similarities)), key=lambda i: similarities[i], reverse=True)[:n]
    
    top_embeddings = [embeddings[i] for i in top_indices]
    top_similarities = [similarities[i] for i in top_indices]
    top_chunks = [chunks[i] for i in top_indices]

    return top_embeddings, top_similarities, top_chunks

if __name__ == "__main__":
    embedding_encoding = "cl100k_base"
    embedding_model = "text-embedding-ada-002"
    max_tokens = 8000 
    buffer = 0.1*max_tokens
    recalc_interval=1000
    target_chunk_len=500
    encoding = tiktoken.get_encoding(embedding_encoding)

    file_ids_string = sys.argv[1]
    file_ids = file_ids_string.split(',')
    search_string = sys.argv[2]  

    all_top_chunks = []

    for file_id in file_ids:
        #print(f"Processing file {file_id}")
        bucket_name = 'source.files.db'
        # Define the base path for uploads
        base_upload_path = '/home/bitnami/stack/projects/sample/uploads'

        # Update file paths to include the base upload path
        s3_key = f'{file_id}.txt'
        local_text_file = os.path.join(base_upload_path, f'{file_id}.txt')  # Path for local text file

        s3_key_embedding = f'{file_id}_embedding.npy'
        local_embedding_file = os.path.join(base_upload_path, f'{file_id}_embedding.npy')  # Path for local embedding file

        s3_key_chunks = f'{file_id}_chunks.npy'
        local_chunks_file = os.path.join(base_upload_path, f'{file_id}_chunks.npy')  # Path for local chunks file


        if not file_exists_in_s3(bucket_name, s3_key_chunks) or not file_exists_in_s3(bucket_name, s3_key_embedding):
            #print("File does not exist in S3. Reupload.")
            continue

        download_file_from_s3(bucket_name, s3_key_embedding, local_embedding_file)
        embeddings = np.load(local_embedding_file)
        
        download_file_from_s3(bucket_name, s3_key_chunks, local_chunks_file)
        chunks = np.load(local_chunks_file)


        top_embeddings, top_similarities, top_chunks = get_search_hits(embeddings, chunks, search_string, n=1)

        if top_chunks:
            all_top_chunks.append({'file_id': file_id, 'chunk': top_chunks[0], 'similarity': top_similarities[0]})
    
    #return the top chunk
    if all_top_chunks:
        all_top_chunks = sorted(all_top_chunks, key=lambda k: k['similarity'], reverse=True)
        output = {
            "file_id": all_top_chunks[0]['file_id'],
            "chunk": all_top_chunks[0]['chunk']
        }

        print(json.dumps(output))

    else:
        print("No results found")

