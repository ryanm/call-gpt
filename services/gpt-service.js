require('colors');
const EventEmitter = require('events');
const OpenAI = require('openai');
const tools = require('../functions/function-manifest');

// Import all functions included in function manifest
// Note: the function name and file name must be the same
const availableFunctions = {};
tools.forEach((tool) => {
  let functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});

class GptService extends EventEmitter {
  constructor() {
    super();
    this.openai = new OpenAI();
    this.userContext = [
      { 'role': 'system', 'content': 'You are a helpful assistant. Use short, clear sentences that sound good when spoken aloud. Always respond in prose. Never use these: bullets, asterisks, boldface, italics, sections, headings, or similar.' },
      { 'role': 'assistant', 'content': "Hey what's up?" },
    ],
    this.partialResponseIndex = 0;
  }

  // Add the callSid to the chat context in case
  // ChatGPT decides to transfer the call.
  setCallSid (callSid) {
    this.userContext.push({ 'role': 'system', 'content': `callSid: ${callSid}` });
  }

  validateFunctionArgs (args) {
    try {
      return JSON.parse(args);
    } catch (error) {
      console.log('Warning: Double function arguments returned by OpenAI:', args);
      // Seeing an error where sometimes we have two sets of args
      if (args.indexOf('{') != args.lastIndexOf('{')) {
        return JSON.parse(args.substring(args.indexOf(''), args.indexOf('}') + 1));
      }
    }
  }

  updateUserContext(name, role, text) {
    if (name !== 'user') {
      this.userContext.push({ 'role': role, 'name': name, 'content': text });
    } else {
      this.userContext.push({ 'role': role, 'content': text });
    }
  }

  async completion(text, interactionCount, role = 'user', name = 'user') {
    this.updateUserContext(name, role, text);

    // Step 1: Send user transcription to Chat GPT
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: this.userContext,
      tools: tools,
      stream: true,
    });

    let completeResponse = '';
    let partialResponse = ''; // For accumulating text for TTS
    let functionName = '';
    let functionArgs = '';
    let finishReason = '';

    function collectToolInformation(deltas) {
      let name = deltas.tool_calls[0]?.function?.name || '';
      if (name != '') {
        functionName = name;
      }
      let args = deltas.tool_calls[0]?.function?.arguments || '';
      if (args != '') {
        // args are streamed as JSON string so we need to concatenate all chunks
        functionArgs += args;
      }
    }

    for await (const chunk of stream) {
      let content = chunk.choices[0]?.delta?.content || '';
      let deltas = chunk.choices[0].delta;
      finishReason = chunk.choices[0].finish_reason;

      if (content) {
        partialResponse += content;
        completeResponse += content; // Accumulate for full context as well
      }

      // Step 2: check if GPT wanted to call a function
      if (deltas.tool_calls) {
        // Step 3: Collect the tokens containing function data
        collectToolInformation(deltas);
      }
      
      // need to call function on behalf of Chat GPT with the arguments it parsed from the conversation
      if (finishReason === 'tool_calls') {
        // Emit any accumulated text before the tool call's "say" message
        if (partialResponse.trim().length > 0) {
          this.emit('gptreply', {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse: partialResponse.trim()
          }, interactionCount);
          this.partialResponseIndex++;
          partialResponse = ''; // Reset for next segment
        }

        const functionToCall = availableFunctions[functionName];
        const validatedArgs = this.validateFunctionArgs(functionArgs);
        
        const toolData = tools.find(tool => tool.function.name === functionName);
        const say = toolData.function.say;

        // Emit the "say" message for the tool
        this.emit('gptreply', {
          partialResponseIndex: null, 
          partialResponse: say
        }, interactionCount);

        functionName = '';
        functionArgs = '';

        let functionResponse = await functionToCall(validatedArgs);
        this.updateUserContext(toolData.function.name, 'function', functionResponse);
        
        // Recursive call to completion for GPT's response after function execution
        await this.completion(functionResponse, interactionCount, 'function', toolData.function.name);
        return; 
      } else {
        // Original logic for emitting based on punctuation or end of stream
        if (content.trim().slice(-1) === '•' || finishReason === 'stop') {
          if (partialResponse.trim().length > 0) {
            const gptReply = { 
              partialResponseIndex: this.partialResponseIndex,
              partialResponse: partialResponse.trim() // Emit accumulated and trimmed content
            };
            this.emit('gptreply', gptReply, interactionCount);
            this.partialResponseIndex++;
            partialResponse = ''; // Clear buffer for the next segment
          }
        }
      }
    }

    // After the loop, emit any remaining text in partialResponse
    if (partialResponse.trim().length > 0) {
      this.emit('gptreply', {
        partialResponseIndex: this.partialResponseIndex,
        partialResponse: partialResponse.trim()
      }, interactionCount);
      this.partialResponseIndex++;
      // partialResponse = ''; // Not strictly necessary here
    }

    // Add the complete assistant response to context if it's not empty
    if (completeResponse) {
      this.userContext.push({'role': 'assistant', 'content': completeResponse});
    }
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }
}

module.exports = { GptService };
