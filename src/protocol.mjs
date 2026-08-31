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

// The live-permission seam. A Pi session whose permission policy lands on
// "ask" escalates through @gotgenes/pi-permission-system's authorizer chain
// (ADR 0007); the bridge registers a link there, emits PERMISSION_REQUEST_EVENT
// broker-ward, and blocks that one ask until a controller answers with a
// `send`/`command` carrying PERMISSION_RESPOND_ACTION. "defer" is the
// hand-back: it falls through to the terminal authorizer, i.e. the human's
// ordinary TUI prompt, so the local operator never loses their button.
export const PERMISSION_REQUEST_EVENT = "permission_request";
export const PERMISSION_RESPOND_ACTION = "permission_respond";
export const PERMISSION_DECISIONS = ["allow", "deny", "defer"];

// Force a context compaction on a named session. The bridge compacts on its own
// once context crosses its threshold mid-tool-loop (the gap upstream pi leaves —
// see extensions/pi-broker-bridge.ts); this is the same lever exposed to a
// human or controller who wants one *now*, in the same shape as prompt and
// interrupt. Optional `text` becomes the compaction's custom instructions.
export const COMPACT_ACTION = "compact";

const requirePermissionVerdict = (message) => {
	required(message, ["requestId", "decision"]);
	if (!PERMISSION_DECISIONS.includes(message.decision))
		throw new Error(
			`permission decision must be one of ${PERMISSION_DECISIONS.join(", ")}`,
		);
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
			if (message.action === PERMISSION_RESPOND_ACTION)
				requirePermissionVerdict(message);
			break;
		case "command":
			required(message, ["id", "action"]);
			if (message.action === PERMISSION_RESPOND_ACTION)
				requirePermissionVerdict(message);
			break;
		case "acquire":
			required(message, ["id", "resource", "holderId"]);
			break;
		case "release":
			required(message, ["id", "resource", "holderId"]);
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
export const acquireMessage = (id, resource, holderId, fields = {}) => ({
	type: "acquire",
	id,
	resource,
	holderId,
	...fields,
});
export const releaseMessage = (id, resource, holderId) => ({
	type: "release",
	id,
	resource,
	holderId,
});
export const responseMessage = (id, fields = {}) => ({
	type: "response",
	id,
	...fields,
});
export const errorMessage = (error) => ({ type: "error", error });

/** Controller -> broker: force a compaction on the named session now. */
export const compactMessage = (id, target, customInstructions) =>
	sendMessage(
		id,
		target,
		COMPACT_ACTION,
		customInstructions === undefined ? {} : { text: customInstructions },
	);

/** Agent -> broker -> controllers: a live `ask` is blocked, waiting on an answer. */
export const permissionRequestMessage = (requestId, fields = {}) =>
	eventMessage(PERMISSION_REQUEST_EVENT, { requestId, ...fields });
/** Controller -> broker: answer the named session's pending `ask`. */
export const permissionRespondMessage = (
	id,
	target,
	requestId,
	decision,
	reason,
) =>
	sendMessage(id, target, PERMISSION_RESPOND_ACTION, {
		requestId,
		decision,
		...(reason === undefined ? {} : { reason }),
	});

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
export const isAcquireMessage = (message) =>
	isValidMessage(message) && message.type === "acquire";
export const isReleaseMessage = (message) =>
	isValidMessage(message) && message.type === "release";
export const isResponseMessage = (message) =>
	isValidMessage(message) && message.type === "response";
export const isErrorMessage = (message) =>
	isValidMessage(message) && message.type === "error";
