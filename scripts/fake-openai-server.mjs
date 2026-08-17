import http from "node:http";

function lastUserText(messages) {
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "deterministic", object: "model" }] }));
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const payload = JSON.parse(body);
    const prompt = lastUserText(payload.messages ?? []);
    const lastMessage = payload.messages?.at(-1);
    const toolRequest = prompt.startsWith("POC_DENY_RM:")
      ? { name: "bash", arguments: { command: `rm -f ${prompt.slice("POC_DENY_RM:".length)}` } }
      : prompt.startsWith("POC_DENY_WRITE:")
        ? {
            name: "write",
            arguments: {
              path: prompt.slice("POC_DENY_WRITE:".length),
              content: "permission escape failure"
            }
          }
        : null;
    const isLong = prompt.includes("POC_LONG");
    const pieces = isLong
      ? Array.from({ length: 100 }, (_, index) => `POC_LONG_TICK_${index} `)
      : [`POC_REPLY:${prompt}`];
    const id = `poc-${Date.now()}`;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });

    if (toolRequest && lastMessage?.role !== "tool") {
      const toolId = `call-${Date.now()}`;
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "deterministic",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: toolId,
                    type: "function",
                    function: {
                      name: toolRequest.name,
                      arguments: JSON.stringify(toolRequest.arguments)
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "deterministic",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
        })}\n\n`
      );
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    if (lastMessage?.role === "tool") {
      pieces.splice(0, pieces.length, "POC_TOOL_RESULT_RETURNED_TO_MODEL");
    }

    let index = 0;
    const emit = () => {
      if (response.destroyed) return;
      if (index < pieces.length) {
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "deterministic",
          choices: [
            {
              index: 0,
              delta: index === 0
                ? { role: "assistant", content: pieces[index] }
                : { content: pieces[index] },
              finish_reason: null
            }
          ]
        };
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        index += 1;
        setTimeout(emit, isLong ? 75 : 1);
        return;
      }
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "deterministic",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        })}\n\n`
      );
      response.write("data: [DONE]\n\n");
      response.end();
    };
    emit();
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(
    `${JSON.stringify({ type: "ready", url: `http://127.0.0.1:${address.port}/v1` })}\n`
  );
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
