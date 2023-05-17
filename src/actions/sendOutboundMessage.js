import { Actions, Manager, Notifications } from "@twilio/flex-ui";
const manager = Manager.getInstance();

const sendOutboundMessage = async (sendOutboundParams) => {
  const body = {
    ...sendOutboundParams,
    Token: manager.store.getState().flex.session.ssoTokenPayload.token,
  };

  console.log("DEBUG body", body);

  const options = {
    method: "POST",
    body: new URLSearchParams(body),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
  };

  const { OpenChatFlag, To } = sendOutboundParams;

  try {
    const resp = await fetch(
      `${process.env.FLEX_APP_TWILIO_SERVERLESS_DOMAIN}/sendOutboundMessage`,
      options
    );
    const data = await resp.json();

    if (!OpenChatFlag && data.success) {
      Notifications.showNotification("outboundMessageSent", {
        message: To,
      });
    }

    if (!data.success) {
      Notifications.showNotification("outboundMessageFailed", {
        message: data.errorMessage,
      });
    }
  } catch (error) {
    console.error(error);
    Notifications.showNotification("outboundMessageFailed", {
      message: "Error calling sendOutboundMessage function",
    });
  }
};

// TODO - fallback and try and use outbound calling setup sids
// TODO - allow override of queue from action payload
Actions.registerAction("SendOutboundMessage", (payload) => {
  const routingSkills = manager.workerClient.attributes.routing.skills;
  let skillNeeded = "";
  let skillBasedCallerId = "";
  let skillBasedQueueSid = "";
  if(routingSkills.includes("Outbound KMI")) {
    skillNeeded = "Outbound KMI";
    skillBasedCallerId = process.env.FLEX_APP_TWILIO_FROM_NUMBER_KMI;
    skillBasedQueueSid = process.env.FLEX_APP_QUEUE_SID_KMI;
  } else {
    skillNeeded = "Outbound CT";
    skillBasedCallerId = process.env.FLEX_APP_TWILIO_FROM_NUMBER_CT;
    skillBasedQueueSid = process.env.FLEX_APP_QUEUE_SID_CT;
  }

  // for CAA demo,
  // remove condition check,
  // always use skillBasedCallerId
  //if (!payload.callerId) {
    payload.callerId = skillBasedCallerId;
  //}

  if (payload.openChat) {
    // create a task immediately
    const sendOutboundParams = {
      OpenChatFlag: true,
      KnownAgentRoutingFlag: false,
      To: payload.destination,
      From: payload.callerId,
      Body: payload.body,
      WorkerSid: manager.workerClient.sid,
      WorkerFriendlyName: manager.user.identity,
      WorkspaceSid: process.env.FLEX_APP_WORKSPACE_SID,
      WorkflowSid: process.env.FLEX_APP_WORKFLOW_SID,
      QueueSid: skillBasedQueueSid,
      InboundStudioFlow: process.env.FLEX_APP_INBOUND_STUDIO_FLOW,
      skillsNeeded: skillNeeded
    };
    sendOutboundMessage(sendOutboundParams);
  } else {
    // send message and inbound triggers studio flow. optional known agent routing
    const sendOutboundParams = {
      OpenChatFlag: false,
      KnownAgentRoutingFlag: !!payload.routeToMe,
      To: payload.destination,
      From: payload.callerId,
      Body: payload.body,
      WorkerSid: manager.workerClient.sid,
      WorkerFriendlyName: manager.user.identity,
      WorkspaceSid: "",
      WorkflowSid: "",
      QueueSid: "",
      InboundStudioFlow: process.env.FLEX_APP_INBOUND_STUDIO_FLOW,
      skillsNeeded: skillNeeded
    };
    sendOutboundMessage(sendOutboundParams);
  }
});
