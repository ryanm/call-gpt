require('dotenv').config();
const { Buffer } = require('node:buffer');
const EventEmitter = require('events');
const { createClient, LiveTTSEvents } = require('@deepgram/sdk');

const VOICE_MODEL = 'aura-2-odysseus-en'; // Example model
const SAMPLE_RATE = 8000; // Ensure this is a number
const ENCODING = 'mulaw';

class TextToSpeechService extends EventEmitter {
  constructor() {
    super();
    this.deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
    this.dgConnection = null;
    this.currentInteractionCount = 0;
    this.currentPartialResponseIndex = 0;
    // this.nextExpectedIndex = 0; // Review if needed
    // this.speechBuffer = {}; // Review if needed

    this._connect();
  }

  _connect() {
    this.dgConnection = this.deepgramClient.speak.live({
      model: VOICE_MODEL,
      encoding: ENCODING,
      sample_rate: SAMPLE_RATE,
      container: 'none', // We want raw audio chunks
    });

    this.dgConnection.on(LiveTTSEvents.Open, () => {
      console.log('Deepgram TTS WebSocket connection opened.');
    });

    this.dgConnection.on(LiveTTSEvents.Audio, (audioChunk) => {
      // audioChunk is a Buffer
      if (audioChunk.length > 0) {
        console.log(`Received audio chunk, length: ${audioChunk.length}`);
        console.log(`Deepgram TTS Audio Chunk: Length=${audioChunk.length}, First 10 bytes (hex)='${audioChunk.slice(0, 10).toString('hex')}'`);
        this.emit('speechChunk', audioChunk, this.currentPartialResponseIndex, this.currentInteractionCount);
      }
    });

    this.dgConnection.on(LiveTTSEvents.Metadata, (metadata) => {
      console.log('Deepgram TTS WebSocket metadata:', metadata);
    });
    
    this.dgConnection.on(LiveTTSEvents.Flushed, () => {
      console.log('Deepgram TTS WebSocket flushed.');
    });

    this.dgConnection.on(LiveTTSEvents.Error, (error) => {
      console.error('Deepgram TTS WebSocket error:', error);
    });

    this.dgConnection.on(LiveTTSEvents.Close, () => {
      console.log('Deepgram TTS WebSocket connection closed.');
      // Optionally, attempt to reconnect or handle cleanup
    });
  }

  generate(gptReply, interactionCount) {
    const { partialResponseIndex, partialResponse } = gptReply;

    if (!partialResponse) {
      return;
    }

    this.currentInteractionCount = interactionCount;
    this.currentPartialResponseIndex = partialResponseIndex;

    if (this.dgConnection && this.dgConnection.getReadyState() === 1) { // 1 means OPEN
      console.log(`Sending text to Deepgram: "${partialResponse}"`);
      this.dgConnection.sendText(partialResponse);
      this.dgConnection.flush();
    } else {
      console.error('Deepgram TTS WebSocket connection not open. State:', this.dgConnection ? this.dgConnection.getReadyState() : 'null');
      // Handle error or queue the request, or try to reconnect
      // For now, just logging. Consider reconnecting:
      // this._connect(); 
      // And then maybe queue/retry:
      // setTimeout(() => this.generate(gptReply, interactionCount), 1000); 
    }
  }

  closeConnection() {
    if (this.dgConnection) {
      console.log('Closing Deepgram TTS WebSocket connection.');
      this.dgConnection.finish(); // Sends a Close message and closes the WebSocket
      this.dgConnection = null;
    }
  }
}

module.exports = { TextToSpeechService };
