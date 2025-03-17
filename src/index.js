/**
 * Cloudflare Worker that accepts a base64 encoded image, sends it to Google's Gemini API,
 * and returns structured data about a restaurant bill.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

// Define the prompt for the Gemini API
const ANALYSIS_PROMPT = `
Provide a a strucuted ouput for the image input which is a bill.
The bill is a restaurant bill and contains food and drinks items.
The strucuted json output should be
\`\`\`json
{
items: [
{
name: "Item Name",
price: 123.45,
quantity: 1
},
{
name: "Item Name",
price: 678.90,
quantity: 2
}
],
total: 1234.56
tax: 123.45
}
\`\`\`
  
Here the tax should include all the taxes applied to each item and the total amount including taxes and tips and service charges etc. Any percentage based addition on the whole value like VAT etc.
`;

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return handleCORS();
    }

    // Only accept POST requests
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      
      // Check if the request is JSON
      if (contentType.includes("application/json")) {
        const requestData = await request.json();
        
        // Validate request data
        if (!requestData.image || !requestData.image.base64Data || !requestData.image.mimeType) {
          return new Response("Invalid request format. Expected: { image: { base64Data: string, mimeType: string } }", 
            { status: 400 });
        }
        
        const { base64Data, mimeType } = requestData.image;
        
        // Check if the MIME type is an image
        if (!mimeType.startsWith("image/")) {
          return new Response("File must be an image", { status: 400 });
        }

        // Process the image with Gemini API
        const result = await processImageWithGemini(base64Data, mimeType, env.GEMINI_API_KEY);
        
        // Return the result with CORS headers
        return new Response(result, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://www.satyajeetnigade.in",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Origin"
          }
        });
      } else {
        return new Response("Request must be application/json", { status: 400 });
      }
    } catch (error) {
      console.error("Error processing request:", error);
      return new Response(`Error processing request: ${error.message}`, { status: 500 });
    }
  }
};

/**
 * Process a base64 encoded image with the Gemini API
 * @param {string} base64Image - Base64 encoded image data
 * @param {string} mimeType - MIME type of the image
 * @param {string} apiKey - Gemini API key
 * @returns {string} - JSON string with analysis results
 */
async function processImageWithGemini(base64Image, mimeType, apiKey) {
  try {
    // Initialize the Gemini API client
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // Create the image part for the Gemini API
    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType
      }
    };

    // Generate content using the model
    const generationResponse = await model.generateContent([ANALYSIS_PROMPT, imagePart]);
    const responseText = generationResponse.response.text();
    
    // Extract the JSON from the response
    // The response might contain markdown code blocks, so we need to extract the JSON
    let jsonData;
    try {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || 
                       responseText.match(/```\s*([\s\S]*?)\s*```/);
                       
      if (jsonMatch && jsonMatch[1]) {
        jsonData = JSON.parse(jsonMatch[1]);
      } else {
        // If no code blocks, try parsing the whole response
        jsonData = JSON.parse(responseText);
      }
    } catch (parseError) {
      // If parsing fails, return the raw text
      return JSON.stringify({ 
        raw_response: responseText,
        error: "Could not parse JSON from response"
      });
    }
    
    return JSON.stringify(jsonData);
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw new Error(`Gemini API error: ${error.message}`);
  }
}

/**
 * Handle CORS preflight requests
 */
function handleCORS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "https://www.satyajeetnigade.in",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Origin",
      "Access-Control-Max-Age": "86400"
    }
  });
}