import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Readable } from "stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authenticate } from "@google-cloud/local-auth";
import fs from "fs";
import { google } from "googleapis";
import { lookup } from "mime-types";
import path from "path";

const drive = google.drive("v3");
const server = new Server(
  {
    name: "example-servers/gdrive",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// 📦 공통 함수: 파일 ID를 이름으로부터 찾아주는 함수
async function resolveFileId(nameOrId: string): Promise<string> {
  if (/^[\w-]{20,}$/.test(nameOrId)) {
    return nameOrId;
  }

  const searchRes = await drive.files.list({
    q: `name = '${nameOrId}'`,
    pageSize: 5,
    fields: "files(id, name)",
  });

  const files = searchRes.data.files || [];
  if (files.length === 0) {
    throw new Error(`파일 이름 '${nameOrId}'에 해당하는 파일을 찾을 수 없습니다.`);
  }

  if (files.length > 1) {
    const list = files.map((file) => `• ${file.name} (ID: ${file.id})`).join("\n");
    throw new Error(`여러 개의 파일이 검색되었습니다. 정확한 파일명을 입력하거나 ID를 직접 지정해 주세요.\n\n${list}`);
  }

  return files[0].id!;
}

// 📄 MIME 타입 추측
function guessMimeType(filename: string) {
  return lookup(filename) || "application/octet-stream";
}
// 📄 리소스 리스트 핸들러
server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const pageSize = 10;
  const params: any = {
    pageSize,
    fields: "nextPageToken, files(id, name, mimeType)",
  };

  if (request.params?.cursor) {
    params.pageToken = request.params.cursor;
  }
  const res = await drive.files.list(params);
  const files = res.data.files || [];
  return {
    resources: files.map((file) => ({
      uri: `gdrive:///${file.id}`,
      mimeType: file.mimeType,
      name: file.name,
    })),
    nextCursor: res.data.nextPageToken,
  };
});

// 📄 파일 읽기 핸들러
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const fileId = await resolveFileId(request.params.uri.replace("gdrive:///", ""));
  const fileRes = await drive.files.get({ fileId: fileId! }, { responseType: "json" });
  const mimeType = fileRes.data.mimeType || "application/octet-stream";

  if (mimeType.startsWith("application/vnd.google-apps")) {
    let exportMimeType;
    switch (mimeType) {
      case "application/vnd.google-apps.document":
        exportMimeType = "text/markdown";
        break;
      case "application/vnd.google-apps.spreadsheet":
        exportMimeType = "text/csv";
        break;
      case "application/vnd.google-apps.presentation":
        exportMimeType = "text/plain";
        break;
      case "application/vnd.google-apps.drawing":
        exportMimeType = "image/png";
        break;
      default:
        exportMimeType = "text/plain";
    }
    const res = await drive.files.export({ fileId: fileId!, mimeType: exportMimeType }, { responseType: "text" });
    return { contents: [{ uri: request.params.uri, mimeType: exportMimeType, text: res.data as string }] };
  } else {
    const res = await drive.files.get({ fileId: fileId! }, { responseType: "arraybuffer" });
    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      return {
        contents: [{ uri: request.params.uri, mimeType, text: Buffer.from(res.data as ArrayBuffer).toString("utf-8") }],
      };
    } else {
      return {
        contents: [
          { uri: request.params.uri, mimeType, blob: Buffer.from(res.data as ArrayBuffer).toString("base64") },
        ],
      };
    }
  }
});

// 📄 툴 리스트 핸들러
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search",
        description: "Search for files in Google Drive",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
      {
        name: "upload_file_with_content",
        description: "Upload a new file with given name and content",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Filename (e.g., test.txt)" },
            content: { type: "string", description: "Text content" },
          },
          required: ["name", "content"],
        },
      },
      {
        name: "update_file_content",
        description: "Update content of an existing file",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "File ID to update" },
            newContent: { type: "string", description: "New text content" },
          },
          required: ["fileId", "newContent"],
        },
      },
      {
        name: "delete_file",
        description: "Delete a file by ID",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "File ID to delete" },
          },
          required: ["fileId"],
        },
      },
      {
        name: "read_file_content",
        description: "Read the content of a text file by filename",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Name of the file to read (e.g., test.txt)" },
          },
          required: ["filename"],
        },
      },
      {
        name: "append_file_content",
        description: "Append new text at the end of an existing file",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Name of the file to append to (e.g., test.txt)" },
            appendText: { type: "string", description: "Text to append" },
          },
          required: ["filename", "appendText"],
        },
      },
      {
        name: "delete_from_file_content",
        description: "Delete specific text from an existing file",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Name of the file to modify (e.g., test.txt)" },
            targetText: { type: "string", description: "Text to delete" },
          },
          required: ["filename", "targetText"],
        },
      },
    ],
  };
});

// 📄 툴 실행 핸들러
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments as any;

  if (request.params.name === "search") {
    const query = (args as { query: string }).query;
    const escapedQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const res = await drive.files.list({
      q: `fullText contains '${escapedQuery}'`,
      pageSize: 10,
      fields: "files(id, name, mimeType, modifiedTime, size)",
    });
    const fileList = res.data.files?.map((file) => `${file.name} (${file.mimeType})`).join("\n");
    return {
      content: [{ type: "text", text: `Found ${res.data.files?.length ?? 0} files:\n${fileList}` }],
      isError: false,
    };
  } else if (request.params.name === "upload_file_with_content") {
    const mimeType = guessMimeType(args.name);
    const bufferStream = new Readable();
    bufferStream.push(Buffer.from(args.content));
    bufferStream.push(null);

    const res = await drive.files.create({
      requestBody: { name: args.name, mimeType },
      media: { mimeType, body: bufferStream },
    });
    return { content: [{ type: "text", text: `파일 업로드 완료: ${res.data.id}` }], isError: false };
  } else if (request.params.name === "update_file_content") {
    const fileId = await resolveFileId(args.fileId);
    const newContent = args.newContent;

    const mimeType = "text/plain";
    const bufferStream = new Readable();
    bufferStream.push(Buffer.from(newContent));
    bufferStream.push(null);

    await drive.files.update({
      fileId,
      media: { mimeType, body: bufferStream },
    });

    return { content: [{ type: "text", text: `파일 업데이트 완료: ${fileId}` }], isError: false };
  } else if (request.params.name === "delete_file") {
    const fileId = await resolveFileId(args.fileId);

    await drive.files.delete({ fileId });

    return { content: [{ type: "text", text: `파일 삭제 완료: ${fileId}` }], isError: false };
  } else if (request.params.name === "read_file_content") {
    const fileId = await resolveFileId(args.filename);
    const fileRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const textContent = Buffer.from(fileRes.data as ArrayBuffer).toString("utf-8");
    return { content: [{ type: "text", text: textContent }], isError: false };
  } else if (request.params.name === "append_file_content") {
    const fileId = await resolveFileId(args.filename);
    const fileRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const currentContent = Buffer.from(fileRes.data as ArrayBuffer).toString("utf-8");
    const updatedContent = currentContent + "\n" + args.appendText;
    const bufferStream = new Readable();
    bufferStream.push(Buffer.from(updatedContent));
    bufferStream.push(null);
    await drive.files.update({ fileId, media: { mimeType: "text/plain", body: bufferStream } });
    return { content: [{ type: "text", text: `파일에 텍스트 추가 완료: ${fileId}` }], isError: false };
  } else if (request.params.name === "delete_from_file_content") {
    const fileId = await resolveFileId(args.filename);
    const fileRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    let currentContent = Buffer.from(fileRes.data as ArrayBuffer).toString("utf-8");
    if (!currentContent.includes(args.targetText)) {
      throw new Error(`파일에 '${args.targetText}' 내용이 존재하지 않습니다.`);
    }
    const updatedContent = currentContent.replace(new RegExp(args.targetText as string, "g"), "");
    const bufferStream = new Readable();
    bufferStream.push(Buffer.from(updatedContent));
    bufferStream.push(null);
    await drive.files.update({ fileId, media: { mimeType: "text/plain", body: bufferStream } });
    return { content: [{ type: "text", text: `파일에서 텍스트 삭제 완료: ${fileId}` }], isError: false };
  }

  throw new Error("Tool not found");
});
// 📄 인증 관련
const credentialsPath =
  process.env.GDRIVE_CREDENTIALS_PATH ||
  path.join(process.env.HOME || process.env.USERPROFILE || "", ".gmail-mcp", "credentials.json");

async function authenticateAndSaveCredentials() {
  console.log("Launching auth flow…");
  const auth = await authenticate({
    keyfilePath:
      process.env.GDRIVE_OAUTH_PATH ||
      path.join(process.env.HOME || process.env.USERPROFILE || "", ".gmail-mcp", "gcp-oauth.keys.json"),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  fs.writeFileSync(credentialsPath, JSON.stringify(auth.credentials));
  console.log("Credentials saved. You can now run the server.");
}

// 📄 서버 시작
async function loadCredentialsAndRunServer() {
  if (!fs.existsSync(credentialsPath)) {
    console.error("Credentials not found. Please run with 'auth' argument first.");
    process.exit(1);
  }
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
  const auth = new google.auth.OAuth2();
  auth.setCredentials(credentials);
  google.options({ auth });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[2] === "auth") {
  authenticateAndSaveCredentials().catch(console.error);
} else {
  loadCredentialsAndRunServer().catch(console.error);
}
