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
      this.emit('tts-ready');
    });

this.dgConnection.on(LiveTTSEvents.Audio, (originalAudioChunk) => {
  if (!originalAudioChunk || originalAudioChunk.length === 0) { // Guard against null/undefined as well
    console.log(`TTS Service: Received empty or null audio chunk from Deepgram. Skipping.`);
    return; 
  }

  let firstNonFFIndex = -1;
  for (let i = 0; i < originalAudioChunk.length; i++) {
    if (originalAudioChunk[i] !== 0xFF) {
      firstNonFFIndex = i;
      break;
    }
  }

  let audioChunkToEmit;

  if (firstNonFFIndex === -1) {
    // All bytes in the original chunk are 0xFF
    console.log(`TTS Service: Audio chunk (Original Length: ${originalAudioChunk.length}) consists entirely of 0xFF bytes (silence). Discarding.`);
    audioChunkToEmit = Buffer.alloc(0); // This ensures it won't be emitted
  } else {
    // Non-0xFF byte(s) found in the original chunk
    if (firstNonFFIndex > 0) {
      // There are leading 0xFFs to trim
      audioChunkToEmit = originalAudioChunk.slice(firstNonFFIndex);
      console.log(`TTS Service: Trimmed ${firstNonFFIndex} leading 0xFF bytes from chunk. Original Length: ${originalAudioChunk.length}, New Length: ${audioChunkToEmit.length}.`);
    } else {
      // No leading 0xFFs (firstNonFFIndex is 0), use the chunk as is
      audioChunkToEmit = originalAudioChunk;
      // Optional: console.log(`TTS Service: Chunk (Length: ${originalAudioChunk.length}) has no leading 0xFF bytes.`);
    }
  }

  if (audioChunkToEmit.length > 0) {
    // Log the processed chunk that will be emitted
    console.log(`TTS Service: Emitting processed audio chunk. Length=${audioChunkToEmit.length}, First 10 hex='${audioChunkToEmit.slice(0, 10).toString('hex')}'`);
    this.emit('speechChunk', audioChunkToEmit, this.currentPartialResponseIndex, this.currentInteractionCount);
  } else {
    // This block is hit if the chunk was all 0xFFs (and thus audioChunkToEmit is empty),
    // or if slicing somehow resulted in an empty buffer (shouldn't happen if original had non-0xFF and firstNonFFIndex was valid).
    if (originalAudioChunk.length > 0) { // Only log if the original chunk wasn't empty
        console.log(`TTS Service: Processed audio chunk is empty (e.g., was all silence or trimmed to empty). Original Length: ${originalAudioChunk.length}. Skipping emission.`);
    }
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

  isReady() {
    return this.dgConnection && this.dgConnection.getReadyState() === 1; // 1 means WebSocket OPEN
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
