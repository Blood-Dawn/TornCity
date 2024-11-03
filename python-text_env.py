from dotenv import load_dotenv
import os
from pathlib import Path

# Specify the full path to the .env file
env_path = Path('.') / '.env'
load_dotenv(dotenv_path=env_path)

print("DISCORD_TOKEN:", os.getenv("DISCORD_TOKEN"))
