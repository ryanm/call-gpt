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
    let ttsBuffer = '';
    let lastChunkTime = Date.now(); // Though not used in current emission logic, good for potential future timeouts
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
      lastChunkTime = Date.now();

      if (content) {
        ttsBuffer += content;
        completeResponse += content; // Accumulate for full context
      }

      // Step 2: check if GPT wanted to call a function
      if (deltas.tool_calls) {
        // Step 3: Collect the tokens containing function data
        collectToolInformation(deltas);
      }
      
      // need to call function on behalf of Chat GPT with the arguments it parsed from the conversation
      if (finishReason === 'tool_calls') {
        // First, emit any buffered text before processing the tool call
        if (ttsBuffer.trim().length > 0) {
          this.emit('gptreply', {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse: ttsBuffer.trim()
          }, interactionCount);
          this.partialResponseIndex++;
          ttsBuffer = '';
        }

        const functionToCall = availableFunctions[functionName];
        const validatedArgs = this.validateFunctionArgs(functionArgs);
        
        const toolData = tools.find(tool => tool.function.name === functionName);
        const say = toolData.function.say;

        this.emit('gptreply', {
          partialResponseIndex: null, 
          partialResponse: say
        }, interactionCount);

        functionName = '';
        functionArgs = '';

        let functionResponse = await functionToCall(validatedArgs);
        this.updateUserContext(toolData.function.name, 'function', functionResponse);
        
        await this.completion(functionResponse, interactionCount, 'function', toolData.function.name);
        return; 
      } else {
        // Check emission criteria for buffered text
        const trimmedBuffer = ttsBuffer.trim();
        if (trimmedBuffer.length > 0 && (ttsBuffer.length >= 30 || /[.,?!]$/.test(trimmedBuffer) || finishReason === 'stop')) {
          this.emit('gptreply', {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse: trimmedBuffer
          }, interactionCount);
          this.partialResponseIndex++;
          ttsBuffer = ''; // Clear buffer after emitting
        }
      }
    }

    // After the loop, flush any remaining text in ttsBuffer
    if (ttsBuffer.trim().length > 0) {
      this.emit('gptreply', {
        partialResponseIndex: this.partialResponseIndex,
        partialResponse: ttsBuffer.trim()
      }, interactionCount);
      this.partialResponseIndex++;
      ttsBuffer = ''; // Clear buffer
    }

    // Add the complete assistant response to context if it's not empty
    if (completeResponse) {
      this.userContext.push({'role': 'assistant', 'content': completeResponse});
    }
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }
}

module.exports = { GptService };
