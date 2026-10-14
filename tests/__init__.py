"""Test package. Keep the developer's local .env out of the test run."""
import os

os.environ["SAHAM_DISABLE_DOTENV"] = "1"
