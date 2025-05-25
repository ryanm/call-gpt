require('colors');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { Buffer } = require('node:buffer');
const EventEmitter = require('events');

const MIN_TRANSCRIPTION_LENGTH = 5;

class TranscriptionService extends EventEmitter {
  constructor() {
    super();
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
    this.dgConnection = deepgram.listen.live({
      encoding: 'mulaw',
      sample_rate: '8000',
      model: 'nova-2',
      punctuate: true,
      interim_results: true,
      endpointing: 200,
      utterance_end_ms: 1000
    });

    this.finalResult = '';
    this.speechFinal = false; // used to determine if we have seen speech_final=true indicating that deepgram detected a natural pause in the speakers speech. 

    this.dgConnection.on(LiveTranscriptionEvents.Open, () => {
      this.dgConnection.on(LiveTranscriptionEvents.Transcript, (transcriptionEvent) => {
        const alternatives = transcriptionEvent.channel?.alternatives;
        let text = '';
        if (alternatives) {
          text = alternatives[0]?.transcript;
        }
        
        // if we receive an UtteranceEnd and speech_final has not already happened then we should consider this the end of of the human speech and emit the transcription
        if (transcriptionEvent.type === 'UtteranceEnd') {
          if (!this.speechFinal) {
            console.log(`UtteranceEnd received before speechFinal, considering to emit: '${this.finalResult}'`.yellow);
            if (this.finalResult && this.finalResult.trim().length > MIN_TRANSCRIPTION_LENGTH) {
              this.emit('transcription', this.finalResult);
            } else {
              console.log(`Skipping emission for short/empty finalResult on UtteranceEnd: '${this.finalResult}'`.yellow);
            }
            this.finalResult = ''; // Reset finalResult after UtteranceEnd processing
            // No need to set this.speechFinal = false here, as speech_final event itself will dictate it.
            return;
          } else {
            console.log('STT -> Speech was already final when UtteranceEnd recevied, no action needed.'.yellow);
            // If speechFinal is true, it means a speech_final event already processed this utterance.
            // We should ensure finalResult is cleared if not already, though speech_final should have done it.
            this.finalResult = ''; 
            return;
          }
        }
    
        // console.log(text, "is_final: ", transcription?.is_final, "speech_final: ", transcription.speech_final);
        // if is_final that means that this chunk of the transcription is accurate and we need to add it to the finalResult 
        if (transcriptionEvent.is_final === true && text.trim().length > 0) {
          this.finalResult += ` ${text}`; // Accumulate final text
          // if speech_final and is_final that means this text is accurate and it's a natural pause in the speakers speech. We need to send this to the assistant for processing
          if (transcriptionEvent.speech_final === true) {
            this.speechFinal = true; // Mark that speech_final has occurred
            console.log(`SpeechFinal received, considering to emit: '${this.finalResult}'`.yellow);
            if (this.finalResult && this.finalResult.trim().length > MIN_TRANSCRIPTION_LENGTH) {
              this.emit('transcription', this.finalResult);
            } else {
              console.log(`Skipping emission for short/empty finalResult on speech_final: '${this.finalResult}'`.yellow);
            }
            this.finalResult = ''; // Reset finalResult after processing speech_final
          } else {
            // if we receive an is_final but not speech_final, it means more speech is expected.
            // Reset speechFinal to false so that a subsequent UtteranceEnd can be authoritative.
            this.speechFinal = false;
          }
        } else {
          this.emit('utterance', text);
        }
      });

      this.dgConnection.on(LiveTranscriptionEvents.Error, (error) => {
        console.error('STT -> deepgram error');
        console.error(error);
      });

      this.dgConnection.on(LiveTranscriptionEvents.Warning, (warning) => {
        console.error('STT -> deepgram warning');
        console.error(warning);
      });

      this.dgConnection.on(LiveTranscriptionEvents.Metadata, (metadata) => {
        console.error('STT -> deepgram metadata');
        console.error(metadata);
      });

      this.dgConnection.on(LiveTranscriptionEvents.Close, () => {
        console.log('STT -> Deepgram connection closed'.yellow);
      });
    });
  }

  /**
   * Send the payload to Deepgram
   * @param {String} payload A base64 MULAW/8000 audio stream
   */
  send(payload) {
    if (this.dgConnection.getReadyState() === 1) {
      this.dgConnection.send(Buffer.from(payload, 'base64'));
    }
  }
}

module.exports = { TranscriptionService };