# EchoScribe Deployment to Vercel

This project is ready to be deployed to [Vercel](https://vercel.com).

## Prerequisites

- A Vercel account.
- A Gemini API Key from [Google AI Studio](https://aistudio.google.com/app/apikey).

## Deployment Steps

1. **Connect to Vercel**:
   - Push your code to a GitHub, GitLab, or Bitbucket repository.
   - Import the project into Vercel.

2. **Configure Environment Variables**:
   - In the Vercel project settings, go to **Environment Variables**.
   - Add a new variable:
     - **Key**: `GEMINI_API_KEY`
     - **Value**: Your Gemini API key.

3. **Deploy**:
   - Vercel will automatically detect the Vite project and use the following settings:
     - **Framework Preset**: `Vite`
     - **Build Command**: `npm run build`
     - **Output Directory**: `dist`
   - Click **Deploy**.

## Local Development

To run the project locally:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the root directory and add your API key:
   ```env
   GEMINI_API_KEY=your_api_key_here
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

## Project Structure

- `src/App.tsx`: Main application logic and UI.
- `vite.config.ts`: Vite configuration with environment variable injection.
- `vercel.json`: Vercel routing configuration for Single Page Applications.
