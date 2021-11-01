import { createServer } from "http";
import { start } from "repl";
import { Server } from "socket.io";

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});
httpServer.listen(8080, () => {
  console.log("listening on 8080");
});

const memberTypeEnum = {
  AGENT: "agent",
  CUSTOMER: "customer",
};

const memberStatusEnum = {
  WAITING: "WAITING",
  ONCALL: "ONCALL",
};

const agentsMap = new Map();
const customersMap = new Map();

const startVideoCall = (agentSocket, customerSocket) => {
  agentSocket.emit("initiateVideoCall");
  agentSocket.on("webrtcOffer", (offer) => {
    customerSocket.emit("webrtcOffer", offer);
  });
  customerSocket.on("webrtcAnswer", (answer) => {
    agentSocket.emit("webrtcAnswer", answer);
  });
  agentSocket.on("new-ice-candidate", (iceCandidate) => {
    customerSocket.emit("new-ice-candidate", iceCandidate);
  });
  customerSocket.on("new-ice-candidate", (iceCandidate) => {
    agentSocket.emit("new-ice-candidate", iceCandidate);
  });
};

const searchForWaitingCustomer = () => {
  for (let [key, value] of customersMap) {
    if (value.status === memberStatusEnum.WAITING) {
      return key;
    }
  }
  return null;
};
const searchForAvailableAgent = () => {
  for (let [key, value] of agentsMap) {
    if (value.status === memberStatusEnum.WAITING) {
      return key;
    }
  }
  return null;
};
const initiateCall = (agentId, customerId, room = null) => {
  const agentDetails = agentsMap.get(agentId);
  const customerDetails = customersMap.get(customerId);
  if (!room) room = agentId.concat(customerId);
  agentDetails.socket.join(room);
  customerDetails.socket.join(room);
  console.log(
    `Connecting Agent ${agentId} to customer ${customerId} in room ${room}`
  );

  agentsMap.set(agentId, {
    ...agentDetails,
    status: memberStatusEnum.ONCALL,
    room: room,
    connectedWith: customerId,
  });
  customersMap.set(customerId, {
    ...customerDetails,
    status: memberStatusEnum.ONCALL,
    room: room,
    connectedWith: agentId,
  });

  io.to(room).emit("room_established", {
    room,
    agentId,
    customerId,
  });

  // begin video
  startVideoCall(agentDetails.socket, customerDetails.socket);
};
const addNewAgent = (socket, agentId) => {
  console.log(`Agent (${agentId}) connected : ${socket.id}`);
  if (agentsMap.has(agentId)) {
    const agentDetails = agentsMap.get(agentId);
    socket.send(`Details of Agent ${agentId} already exist`);
    agentsMap.set(agentId, {
      ...agentDetails,
      socket: socket,
    });
    if (agentDetails.connectedWith) {
      initiateCall(agentId, agentDetails.connectedWith, agentDetails.room);
    }
  } else {
    agentsMap.set(agentId, {
      socket: socket,
      status: memberStatusEnum.WAITING,
      room: null,
      connectedWith: null,
    });
    const waitingCustomerId = searchForWaitingCustomer();
    if (waitingCustomerId) initiateCall(agentId, waitingCustomerId);
  }
};

const addNewCustomer = (socket, customerId) => {
  console.log(`Customer (${customerId}) connected : ${socket.id}`);
  if (customersMap.has(customerId)) {
    const customerDetails = customersMap.get(customerId);
    socket.send(`Details of Customer ${customerId} already exist`);
    customersMap.set(customerId, {
      ...customerDetails,
      socket: socket,
    });
    if (customerDetails.connectedWith) {
      initiateCall(
        customerDetails.connectedWith,
        customerId,
        customerDetails.room
      );
    }
  } else {
    customersMap.set(customerId, {
      socket: socket,
      status: memberStatusEnum.WAITING,
      room: null,
      connectedWith: null,
    });
    const availableAgentId = searchForAvailableAgent();
    if (availableAgentId) initiateCall(availableAgentId, customerId);
  }
};

const callCompletedFromAgent = (agentId) => {
  console.log(
    `call between agent ${agentId} and customer ${
      agentsMap.get(agentId).connectedWith
    } is completed`
  );

  const customerId = agentsMap.get(agentId).connectedWith;
  const room = agentsMap.get(agentId).room;
  io.to(room).emit("room_destroy", {
    room,
    agentId,
    customerId,
  });
  io.socketsLeave(room); // empting room

  agentsMap.set(agentId, {
    ...agentsMap.get(agentId),
    status: memberStatusEnum.WAITING,
    room: null,
    connectedWith: null,
  });
  customersMap.get(customerId).socket.disconnect(true);
  customersMap.delete(customerId);
  console.log(`removing data of customer ${customerId}`);
};

io.on("connection", (socket) => {
  const { memberType, memberId } = socket.handshake.query;

  memberType === memberTypeEnum.AGENT
    ? addNewAgent(socket, memberId)
    : addNewCustomer(socket, memberId);

  socket.on("disconnect", (reason) => {
    console.log(
      `${memberType}(${memberId}) disconnected : ${socket.id} due to ${reason}`
    );
    if (
      reason === "server namespace disconnect" ||
      reason === "client namespace disconnect"
    ) {
      memberType === memberTypeEnum.AGENT
        ? agentsMap.delete(memberId)
        : customersMap.delete(memberId);
      console.log(`removing data of ${memberType} ${memberId}`);
    }
  });

  socket.on("call_complete", () => callCompletedFromAgent(memberId));
});
