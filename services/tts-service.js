require('dotenv').config();
const { Buffer } = require('node:buffer');
const EventEmitter = require('events');
const fetch = require('node-fetch');

const VOICE_MODEL = 'aura-2-odysseus-en';
const SAMPLE_RATE = 8000; 
const ENCODING = 'mulaw';

class TextToSpeechService extends EventEmitter {
  constructor() {
    super();
    // Properties like nextExpectedIndex and speechBuffer from the original non-streaming version
    // are not included in this revert plan, but can be added if needed for functionality
    // that was present before the streaming refactor.
    // For now, keeping it minimal as per the revert plan.
  }

  async generate(gptReply, interactionCount) {
    const { partialResponseIndex, partialResponse } = gptReply;

    if (!partialResponse) { 
      console.log('TTS Service: Received empty partialResponse. Skipping generation.');
      return; 
    }

    // Construct the Deepgram API URL
    // Using container=none to get raw audio, assuming this is desired for mulaw/8000Hz.
    const url = `https://api.deepgram.com/v1/speak?model=${VOICE_MODEL}&encoding=${ENCODING}&sample_rate=${SAMPLE_RATE}&container=none`;

    console.log(`TTS Service: Generating audio for (Interaction: ${interactionCount}, Index: ${partialResponseIndex}): "${partialResponse}"`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: partialResponse,
        }),
      });

      if (response.status === 200) {
        const blob = await response.blob(); 
        const audioArrayBuffer = await blob.arrayBuffer();
        const base64String = Buffer.from(audioArrayBuffer).toString('base64');
        
        console.log(`TTS Service: Successfully generated audio. Emitting 'speech' event. Length: ${base64String.length}`);
        // Emit 'speech' event with base64 audio, and include original text for context if needed by listeners
        this.emit('speech', partialResponseIndex, base64String, partialResponse, interactionCount);
      } else {
        const errorBody = await response.text();
        console.error(`Deepgram TTS API Error (Interaction: ${interactionCount}, Index: ${partialResponseIndex}): ${response.status} - ${errorBody}`);
      }
    } catch (err) {
      console.error(`Error in TextToSpeechService during Deepgram API call (Interaction: ${interactionCount}, Index: ${partialResponseIndex}):`, err);
    }
  }
}

module.exports = { TextToSpeechService };
