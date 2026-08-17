// The deliberately small, version-free JSONL wire protocol used by the broker.

const isRecord = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const required = (message, fields) => {
	for (const field of fields) {
		if (
			message[field] === undefined ||
			message[field] === null ||
			message[field] === ""
		) {
			throw new Error(`message ${message.type ?? ""} requires ${field}`.trim());
		}
	}
};

export function validateMessage(message) {
	if (!isRecord(message) || typeof message.type !== "string" || !message.type) {
		throw new Error("message requires a type");
	}
	switch (message.type) {
		case "register":
			required(message, ["role"]);
			if (!["agent", "controller"].includes(message.role))
				throw new Error("unknown registration role");
			if (message.role === "agent") required(message, ["sessionId"]);
			break;
		case "event":
			required(message, ["event"]);
			break;
		case "list":
			required(message, ["id"]);
			break;
		case "send":
			required(message, ["id", "target", "action"]);
			break;
		case "command":
			required(message, ["id", "action"]);
			break;
		case "response":
			required(message, ["id"]);
			break;
		case "error":
			required(message, ["error"]);
			break;
		case "registered":
			break;
		default:
			throw new Error(`unknown message type: ${message.type}`);
	}
	return message;
}

export function parseMessage(value) {
	let message;
	try {
		message = typeof value === "string" ? JSON.parse(value) : value;
	} catch {
		throw new Error("invalid JSON message");
	}
	return validateMessage(message);
}

export const registerMessage = (role, sessionId) => ({
	type: "register",
	role,
	...(sessionId === undefined ? {} : { sessionId }),
});
export const eventMessage = (event, fields = {}) => ({
	type: "event",
	event,
	...fields,
});
export const listMessage = (id) => ({ type: "list", id });
export const sendMessage = (id, target, action, fields = {}) => ({
	type: "send",
	id,
	target,
	action,
	...fields,
});
export const commandMessage = (id, action, fields = {}) => ({
	type: "command",
	id,
	action,
	...fields,
});
export const responseMessage = (id, fields = {}) => ({
	type: "response",
	id,
	...fields,
});
export const errorMessage = (error) => ({ type: "error", error });

export const isValidMessage = (message) => {
	try {
		validateMessage(message);
		return true;
	} catch {
		return false;
	}
};
export const isRegisterMessage = (message) =>
	isValidMessage(message) && message.type === "register";
export const isEventMessage = (message) =>
	isValidMessage(message) && message.type === "event";
export const isListMessage = (message) =>
	isValidMessage(message) && message.type === "list";
export const isSendMessage = (message) =>
	isValidMessage(message) && message.type === "send";
export const isCommandMessage = (message) =>
	isValidMessage(message) && message.type === "command";
export const isResponseMessage = (message) =>
	isValidMessage(message) && message.type === "response";
export const isErrorMessage = (message) =>
	isValidMessage(message) && message.type === "error";
