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
from dotenv import load_dotenv

dotenv_path = '/home/bitnami/stack/projects/sample/.env'

# Check if the .env file exists
if os.path.exists(dotenv_path):
    print(f"Loading environment variables from: {dotenv_path}")
    load_dotenv(dotenv_path)
else:
    print(f".env file not found at: {dotenv_path}")
    # Handle the absence of the .env file appropriately

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
            print(f"Adjusted average tokens per word: {avg_tokens_per_word:.2f}")

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


# Example function that takes input and returns output
def process_data(input_data):
    # Process input_data and return result
    #print(input_data)
    input_data = json.loads(input_data)  # Convert JSON string to Python dict
    return {'result': 'processed data'}


if __name__ == "__main__":
    embedding_encoding = "cl100k_base"
    embedding_model = "text-embedding-ada-002"
    max_tokens = 8000 
    buffer = 0.1*max_tokens
    recalc_interval=1000
    target_chunk_len=500
    encoding = tiktoken.get_encoding(embedding_encoding)

    file_id = sys.argv[1]  # Get input from the command line argument

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

    download_file_from_s3(bucket_name, s3_key, local_text_file)

    with open(local_text_file, 'r') as file:
        text = file.read()

    text = preprocess_text(text)

    chunks = get_chunks(text, encoding, max_tokens=max_tokens, target_chunk_len=target_chunk_len, buffer=buffer, recalc_interval=recalc_interval)
    
    embeddings = []

    index = 0
    for chunk in chunks:
        try:
            chunk_embedding = get_embedding(chunk, model='text-embedding-ada-002')
            embeddings.append(chunk_embedding)
            index += 1
            print(f"Chunk {index} of {len(chunks)}")
        except Exception as e:
            print(f"Error with chunk {index}")
            print(chunk)
            print(len(chunk))
            print(len(encoding.encode(chunk)))
            print(f"Error: {e}")
            break

    
    np.save(local_embedding_file, embeddings)
    np.save(local_chunks_file, chunks)
    
    
    upload_file_to_s3(bucket_name, s3_key_embedding, local_embedding_file)

    # Upload chunks file
    upload_file_to_s3(bucket_name, s3_key_chunks, local_chunks_file)
    
    if not file_exists_in_s3(bucket_name, s3_key_chunks) or not file_exists_in_s3(bucket_name, s3_key_embedding):
        print("Files not found in S3")
    else:
         print("Files uploaded to S3 succesfully")

    
