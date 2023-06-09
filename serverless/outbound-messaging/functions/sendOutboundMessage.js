const TokenValidator = require("twilio-flex-token-validator").functionValidator;

// Create a flex interaction that targets the agent with a task and add in a message to the conversation
const openAChatTask = async (
  client,
  To,
  From,
  Body,
  WorkerFriendlyName,
  WorkerSid,
  routingProperties
) => {
  const channelType = To.startsWith("whatsapp") ? "whatsapp" : "sms";
  console.log(To, From, Body, WorkerFriendlyName, WorkerSid, routingProperties);
  const interaction = await client.flexApi.v1.interaction.create({
    channel: {
      type: channelType,
      initiated_by: "agent",
      participants: [
        {
          address: To,
          proxy_address: From,
        },
      ],
    },
    routing: {
      properties: {
        ...routingProperties,
        task_channel_unique_name: "chat",
        attributes: {
          from: From,
          direction: "outbound",
          customerName: "Customer",
          customerAddress: To,
          twilioNumber: From,
          channelType: channelType,
        },
      },
    },
  });

  console.log(interaction);
  const taskAttributes = JSON.parse(interaction.routing.properties.attributes);
  console.log(taskAttributes);

  const message = await client.conversations.v1
    .conversations(taskAttributes.conversationSid)
    .messages.create({ author: WorkerFriendlyName, body: Body });

  console.log(message);

  return {
    success: true,
    interactionSid: interaction.sid,
    conversationSid: taskAttributes.conversationSid,
  };
};

const sendOutboundMessage = async (
  client,
  To,
  From,
  Body,
  KnownAgentRoutingFlag,
  WorkerFriendlyName,
  WorkerSid,
  InboundStudioFlow,
  skillsNeeded
) => {
  const friendlyName = `Outbound ${From} -> ${To}`;
  console.log(friendlyName);
  console.log("Studio flow SID is", InboundStudioFlow);

  // Set flag in channel attribtues so Studio knows if it should set task attribute to target known agent
  let converstationAttributes = { KnownAgentRoutingFlag };
  if (KnownAgentRoutingFlag) {
    converstationAttributes.KnownAgentWorkerFriendlyName = WorkerFriendlyName;
    converstationAttributes.KnownAgentWorkerSid = WorkerSid;
  }
  converstationAttributes.skillsNeeded = skillsNeeded;
  const attributes = JSON.stringify(converstationAttributes);

  // Create Channel
  const channel = await client.conversations.v1.conversations.create({
    friendlyName,
    attributes,
  });

  console.log(channel);
  try {
    // Add customer to channel
    const participant = await client.conversations.v1
      .conversations(channel.sid)
      .participants.create({
        "messagingBinding.address": To,
        "messagingBinding.proxyAddress": From,
      });

    console.log(participant);
  } catch (error) {
    console.log(error);

    if (error.code === 50416)
      return {
        success: false,
        errorMessage: `Error sending message. There is an open conversation already to ${To}`,
      };
    else
      return {
        success: false,
        errorMessage: `Error sending message. Error occured adding ${To} channel`,
      };
  }

  // Point the channel to Studio
  const webhook = await client.conversations.v1
    .conversations(channel.sid)
    .webhooks.create({
      target: 'studio',
      'configuration.flowSid': `${InboundStudioFlow}`
    });

  console.log(webhook);

  // Add agents initial message
  const message = await client.conversations.v1
    .conversations(channel.sid)
    .messages.create({ author: WorkerFriendlyName, body: Body });

  console.log(message);

  return { success: true, channelSid: channel.sid };
};

exports.handler = TokenValidator(async function (context, event, callback) {
  const {
    To,
    From,
    Body,
    WorkspaceSid,
    WorkflowSid,
    QueueSid,
    WorkerSid,
    WorkerFriendlyName,
    InboundStudioFlow,
    skillsNeeded
  } = event;

  let { OpenChatFlag, KnownAgentRoutingFlag } = event;
  OpenChatFlag = OpenChatFlag === "true" ? true : false;
  KnownAgentRoutingFlag = KnownAgentRoutingFlag === "true" ? true : false;

  const client = context.getTwilioClient();

  // Create a custom Twilio Response
  // Set the CORS headers to allow Flex to make an HTTP request to the Twilio Function
  const response = new Twilio.Response();
  response.appendHeader("Access-Control-Allow-Origin", "*");
  response.appendHeader("Access-Control-Allow-Methods", "OPTIONS POST GET");
  response.appendHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    let sendResponse = null;

    // Check if there is already an active conversation for
    // the TO number
    // Get all conversations for a participant
    const conversations = await client
      .conversations
      .v1
      .participantConversations
      .list({address: To});

    let errorCount = 0;
    let foundCount = 0;
    let agentName = "";

    // Use for loop to sequentially fetch info
    // (slow, but avoids hammering API and getting 'Too many requests' errors)
    for(let x=0; x < conversations.length; x++) {
        try {
            const conversation = await client
                .conversations
                .v1
                .conversations(conversations[x].conversationSid)
                .fetch();
            if(conversation.state == "active") {

              const participants = await client
                .conversations
                .v1
                .conversations(conversations[x].conversationSid)
                .participants.list();

              participants.forEach(p => {
                agentName = p.identity ? p.identity : agentName;
              });

              const workerList = await client
                .taskrouter
                .v1
                .workspaces(WorkspaceSid)
                .workers
                .list({ targetWorkersExpression: `friendly_name IN ['${agentName}']` });
              if(workerList.length > 0) {
                agentName = JSON.parse(workerList[0].attributes).full_name;
              }

              // Check if this is inbound or not
              // Check if this is for the same queue or skill as an existing outbound
              // -- extra checks replacing this:  evaluateTaskAttributes: `direction == "inbound" AND conversationSid == "${conversation.sid}"`
              // Conditions:
              // -- Existing Inbound (aka roadside assistance) messages do not keep outbound messages from being created.
              // -- Existing Outbound regardless of skill/queue DO keep new outbound from being created.


              const taskList = await client.taskrouter.v1.workspaces(WorkspaceSid)
                .tasks
                .list({
                  assignmentStatus: "assigned",
                  evaluateTaskAttributes: `conversationSid == "${conversation.sid}"`
                });

              // If there's one existing task, and it is NOT inbound, we can't create another.
              if(taskList.length == 1 && JSON.parse(taskList[0].attributes).skillsNeeded != "Inbound") {
                foundCount++;
              }

              // If there's more than one existing task, it can only be one inbound and one outbound,
              // because of the above check.  So that means we can't create any more outbound (which
              // is the only reason we're running this code at all)
              if(taskList.length > 1) {
                foundCount++;
              }
              // If foundCount is NOT zero, we found a reason to NOT create the outbound message.

            }
        }
        catch(e) {
            errorCount++;
        }
    }

    // If foundCount is not zero, we found a reason to NOT create the outbound message.
    if(foundCount > 0) {
      sendResponse = {
        success: false,
        errorMessage: `Agent ${agentName} has an active conversation with this member at phone ${To}`,
      };
    } else {
      if (OpenChatFlag) {
        // create task and add the message to a channel
        sendResponse = await openAChatTask(
          client,
          To,
          From,
          Body,
          WorkerFriendlyName,
          WorkerSid,
          {
            workspace_sid: WorkspaceSid,
            workflow_sid: WorkflowSid,
            queue_sid: QueueSid,
            worker_sid: WorkerSid,
          }
        );
      } else {
        // create a channel but wait until customer replies before creating a task
        sendResponse = await sendOutboundMessage(
          client,
          To,
          From,
          Body,
          KnownAgentRoutingFlag,
          WorkerFriendlyName,
          WorkerSid,
          InboundStudioFlow,
          skillsNeeded
        );
      }
    }

    response.appendHeader("Content-Type", "application/json");
    response.setBody(sendResponse);
    // Return a success response using the callback function.
    callback(null, response);
  } catch (err) {
    response.appendHeader("Content-Type", "plain/text");
    response.setBody(err.message);
    response.setStatusCode(500);
    // If there's an error, send an error response
    // Keep using the response object for CORS purposes
    console.error(err);
    callback(null, response);
  }
});
