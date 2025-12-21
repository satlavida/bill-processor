/**
 * Cloudflare Worker that accepts a base64 encoded image, sends it to OpenRouter,
 * and returns structured data about a restaurant bill.
 */

// Define the prompt for the OpenRouter request
const ANALYSIS_PROMPT = `
You are given an image of a restaurant bill that includes food and drink items.

Instructions:

Extract all ordered items under the items array.
For each item:
Extract the full item name. If the item name spills onto the next line (e.g., "Paneer Aloo Mattar" on one line and "Sabji" on the next), merge them into a single name.
Extract the quantity. If not explicitly mentioned, default to 1. If in the format Beer 6 1200, interpret it as 6 beers costing 1200 total, and set price as 1200 / 6 = 200.00.
Extract the total item price (before any tax or service charge).
Detect any discounts:
If the bill shows an overall flat discount, add it as a separate item with a negative price.
If discounts apply only to certain items, keep their final price after discount and include a discount field with:
  discount: {
    value: <discount amount or percentage>,
    discountType: "flat" | "percentage"
  }
For percentage discounts, value is the percent off. For flat discounts, value is the amount subtracted.
Calculate the final per-unit price after subtracting the discount:
price = (item total - discount) / quantity.
Apply item-level discounts before computing price.

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
      "quantity": 1,
      "discount": {
        "value": 10,
        "discountType": "percentage"
      }
    },
    {
      "name": "Discount",
      "price": -5.00,
      "quantity": 1
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
    const allowedOrigin = findAllowedOrigin(origin, ALLOWED_ORIGINS);
    
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
      if (!env.OPENROUTER_API_KEY) {
        return new Response("OPENROUTER_API_KEY is not configured.", { status: 500 });
      }

      const { error: payloadError, payload } = await parseImagePayload(request);
      if (payloadError) {
        return new Response(payloadError, { status: 400 });
      }

      const { base64Data, mimeType } = payload;

      // Process the image with OpenRouter
      const result = await processImageWithOpenRouter(base64Data, mimeType, env.OPENROUTER_API_KEY);

      // Return the result with CORS headers
      return withCors(
        new Response(result, { headers: { "Content-Type": "application/json" } }),
        allowedOrigin
      );
    } catch (error) {
      console.error("Error processing request:", error);
      return new Response(`Error processing request: ${error.message}`, { status: 500 });
    }
  }
};

/**
 * Process a base64 encoded image with the OpenRouter API
 * @param {string} base64Image - Base64 encoded image data
 * @param {string} mimeType - MIME type of the image
 * @param {string} apiKey - OpenRouter API key
 * @returns {string} - JSON string with analysis results
 */
async function processImageWithOpenRouter(base64Image, mimeType, apiKey) {
  try {
    const requestBody = buildOpenRouterRequest(ANALYSIS_PROMPT, base64Image, mimeType);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: buildOpenRouterHeaders(apiKey),
      body: JSON.stringify(requestBody)
    });

    await assertOpenRouterOk(response);

    const responseData = await response.json();
    const responseText = extractOpenRouterContent(responseData);

    return stringifyParsedResponse(responseText);
  } catch (error) {
    console.error("Error calling OpenRouter:", error);
    throw new Error(`OpenRouter API error: ${error.message}`);
  }
}

function findAllowedOrigin(origin, allowedOrigins) {
  return allowedOrigins.find((allowed) => origin.includes(allowed)) || null;
}

async function parseImagePayload(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return { error: "Request must be application/json", payload: null };
  }

  const requestData = await request.json();
  const image = requestData?.image;

  if (!image?.base64Data || !image?.mimeType) {
    return {
      error: "Invalid request format. Expected: { image: { base64Data: string, mimeType: string } }",
      payload: null
    };
  }

  if (!image.mimeType.startsWith("image/")) {
    return { error: "File must be an image", payload: null };
  }

  return { error: null, payload: image };
}

function buildOpenRouterHeaders(apiKey) {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function buildOpenRouterRequest(prompt, base64Image, mimeType) {
  return {
    model: "google/gemini-2.5-flash-lite",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`
            }
          }
        ]
      }
    ]
  };
}

async function assertOpenRouterOk(response) {
  if (response.ok) {
    return;
  }

  const errorBody = await response.text();
  throw new Error(`OpenRouter error ${response.status}: ${errorBody}`);
}

function extractOpenRouterContent(responseData) {
  const responseText = responseData?.choices?.[0]?.message?.content;
  if (!responseText) {
    throw new Error("OpenRouter response missing message content.");
  }
  return responseText;
}

function extractJsonString(responseText) {
  const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
    responseText.match(/```\s*([\s\S]*?)\s*```/);
  return jsonMatch?.[1] ?? responseText;
}

function stringifyParsedResponse(responseText) {
  try {
    const jsonData = JSON.parse(extractJsonString(responseText));
    return JSON.stringify(jsonData);
  } catch (parseError) {
    return JSON.stringify({
      raw_response: responseText,
      error: "Could not parse JSON from response"
    });
  }
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin || "");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Origin");
  return new Response(response.body, { status: response.status, headers });
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

export {
  assertOpenRouterOk,
  buildOpenRouterHeaders,
  buildOpenRouterRequest,
  extractJsonString,
  extractOpenRouterContent,
  findAllowedOrigin,
  parseImagePayload,
  stringifyParsedResponse,
  withCors
};
