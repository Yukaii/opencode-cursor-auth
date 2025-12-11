
import { FileCredentialManager } from "../src/lib/storage";
import { createCursorClient } from "../src/lib/api/cursor-client";

async function main() {
  // 1. Get credentials
  const cm = new FileCredentialManager("cursor");
  const token = await cm.getAccessToken();

  if (!token) {
    console.error("No access token found. Please run 'bun run scripts/auth-demo.ts login' first.");
    process.exit(1);
  }

  console.log("Using access token:", token.substring(0, 10) + "...");

  // 2. Create client
  const client = createCursorClient(token);

  // 3. Send chat request
  console.log("\nSending chat request: 'Hello, who are you?'...");
  
  const request = {
    model: "claude-3.5-sonnet", // Use a known good model
    messages: [
      { role: "user" as const, content: "Hello, who are you?" }
    ],
    stream: true
  };

  try {
    console.log("\n--- Response Stream ---");
    let fullText = "";
    
    for await (const chunk of client.chatStream(request)) {
      if (chunk.type === "delta" && chunk.content) {
        process.stdout.write(chunk.content);
        fullText += chunk.content;
      } else if (chunk.type === "error") {
        console.error("\n\nError chunk received:", chunk.error);
      }
    }
    console.log("\n\n--- End of Stream ---");
    
    if (fullText.length > 0) {
      console.log("\nTest PASSED: Received response.");
    } else {
      console.log("\nTest FAILED: No content received.");
    }

  } catch (error) {
    console.error("\nError during chat stream:", error);
  }
}

main().catch(console.error);
