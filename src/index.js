/**
 * Cloudflare Worker that accepts a base64 encoded image, sends it to Google's Gemini API,
 * and returns structured data about a restaurant bill.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

// Define the prompt for the Gemini API
const ANALYSIS_PROMPT = `
You are given an image of a restaurant bill that includes food and drink items.

Instructions:

Extract all ordered items under the items array.
For each item:
Extract the full item name. If the item name spills onto the next line (e.g., "Paneer Aloo Mattar" on one line and "Sabji" on the next), merge them into a single name.
Extract the quantity. If not explicitly mentioned, default to 1. If in the format Beer 6 1200, interpret it as 6 beers costing 1200 total, and set price as 1200 / 6 = 200.00.
Extract the total item price (before any tax or service charge).
Detect and apply any discounts shown (e.g., minus -, strikethrough, or labeled as discount). Apply the discount directly on the item’s total price.
Calculate the final per-unit price after discount:
price = (item total - discount) / quantity.
Apply all discounts before price extraction. Do not list separate discount lines. Instead, reflect the discounted amount in the item's price field directly.

Tax Field:
Include all service charges, tips, VAT, GST, or surcharges under the tax field.
If multiple components are listed separately, sum them.

Subtotal:
Sum of (price × quantity) for all items after discount, but before tax.

Total:
Final billed amount paid, including tax and all charges.

Validation:
Ensure: subtotal + tax == total (or within a rounding error of ±0.01).
If mismatch is detected, attempt to re-check discount and price calculations.
Output format:

{
  "items": [
    {
      "name": "Item Name",
      "price": 123.45,
      "quantity": 1
    },
    {
      "name": "Item Name",
      "price": 200.00,
      "quantity": 6
    }
  ],
  "subtotal": 1345.67,
  "tax": 123.45,
  "total": 1469.12
}
`;

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'http://localhost:8000',            // Development environment
  'https://www.satyajeetnigade.in'    // Production environment
];

export default {
  async fetch(request, env, ctx) {
    // Get the request origin
    const origin = request.headers.get("Origin") || "";
    
    // Check if the origin is allowed
    const allowedOrigin = ALLOWED_ORIGINS.find(allowed => origin.includes(allowed)) || null;
    
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return handleCORS(allowedOrigin);
    }

    // Only accept POST requests
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    
    // If origin is not allowed, reject the request
    if (!allowedOrigin) {
      return new Response("Not allowed", { status: 403 });
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
            "Access-Control-Allow-Origin": allowedOrigin,
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
 * @param {string} origin - The allowed origin for the request
 */
function handleCORS(origin) {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": origin || "",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Origin",
      "Access-Control-Max-Age": "86400"
    }
  });
}