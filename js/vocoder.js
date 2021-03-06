/*
 * Copyright (c) 2012 The Chromium Authors. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *    * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *    * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *    * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

function Vocoder(){
  this.audioContext = null;
  this.modulatorBuffer = null;
  this.carrierBuffer = null;
  this.modulatorNode = null;
  this.carrierNode = null;
  this.vocoding = false;

  this.FILTER_QUALITY = 6;  // The Q value for the carrier and modulator filters


  // These are "placeholder" gain nodes - because the modulator and carrier will get swapped in
  // as they are loaded, it's easier to connect these nodes to all the bands, and the "real"
  // modulator & carrier AudioBufferSourceNodes connect to these.
  this.modulatorInput = null;
  this.carrierInput = null;

  this.modulatorGain = null;
  this.modulatorGainValue = 1.0;

  // noise node added to the carrier signal
  this.noiseBuffer = null;
  this.noiseNode = null;
  this.noiseGain = null;
  this.noiseGainValue = 0.1;

  // Carrier sample gain
  this.carrierSampleNode = null;
  this.carrierSampleGain = null;
  this.carrierSampleGainValue = 0.0;

  // Carrier Synth oscillator stuff
  this.oscillatorNode = null;
  this.oscillatorType = 4;   // CUSTOM
  this.oscillatorGain = null;
  this.oscillatorGainValue = 1.0;
  this.oscillatorDetuneValue = 0;
  this.FOURIER_SIZE = 2048;
  this.wavetable = null;
  this.wavetableSignalGain = null;
  this.WAVETABLEBOOST = 120.0;
  this.SAWTOOTHBOOST = 0.4;

  // These are the arrays of nodes - the "columns" across the frequency band "rows"
  this.modFilterBands = null;    // tuned bandpass filters
  this.modFilterPostGains = null;  // post-filter gains.
  this.heterodynes = null;   // gain nodes used to multiply bandpass X sine
  this.powers = null;      // gain nodes used to multiply prev out by itself
  this.lpFilters = null;   // tuned LP filters to remove doubled copy of product
  this.lpFilterPostGains = null;   // gain nodes for tuning input to waveshapers
  this.bandAnalysers = null; // these are just used to drive the visual vocoder band drawing
  this.carrierBands = null;  // tuned bandpass filters, same as modFilterBands but in carrier chain
  this.carrierFilterPostGains = null;  // post-bandpass gain adjustment
  this.carrierBandGains = null;  // these are the "control gains" driven by the lpFilters

  this.vocoderBands;
  this.numVocoderBands;

  this.hpFilterGain = null;

  this.rafID = null;
  this.lpInputFilter=null;
}


// this function will algorithmically re-calculate vocoder bands, distributing evenly
// from startFreq to endFreq, splitting evenly (logarhythmically) into a given numBands.
// The function places this info into the global vocoderBands and this.numVocoderBands variables.
Vocoder.prototype.generateVocoderBands = function( startFreq, endFreq, numBands) {
  // Remember: 1200 cents in octave, 100 cents per semitone

  var totalRangeInCents = 1200 * Math.log( endFreq / startFreq ) / Math.LN2;
  var centsPerBand = totalRangeInCents / numBands;
  var scale = Math.pow( 2, centsPerBand / 1200 );  // This is the scaling for successive bands

  this.vocoderBands = new Array();
  var currentFreq = startFreq;

  for (var i=0; i<numBands; i++) {
    this.vocoderBands[i] = new Object();
    this.vocoderBands[i].frequency = currentFreq;
//    console.log( "Band " + i + " centered at " + currentFreq + "Hz" );
    currentFreq = currentFreq * scale;
  }

  this.numVocoderBands = numBands;
}

Vocoder.prototype.loadNoiseBuffer = function() {  // create a 5-second buffer of noise
    var lengthInSamples =  5 * this.audioContext.sampleRate;
    this.noiseBuffer = this.audioContext.createBuffer(1, lengthInSamples, this.audioContext.sampleRate);
    var bufferData = this.noiseBuffer.getChannelData(0);
    
    for (var i = 0; i < lengthInSamples; ++i) {
        bufferData[i] = (2*Math.random() - 1);  // -1 to +1
    }
}
Vocoder.prototype.initBandpassFilters = function() {
  // When this function is called, the carrierNode and modulatorAnalyser 
  // may not already be created.  Create placeholder nodes for them.
  this.modulatorInput = this.audioContext.createGain();
  this.carrierInput = this.audioContext.createGain();

  if (this.modFilterBands == null)
    this.modFilterBands = new Array();

  if (this.modFilterPostGains == null)
    this.modFilterPostGains = new Array();

  if (this.heterodynes == null)
    this.heterodynes = new Array();
  
  if (this.powers == null)
    this.powers = new Array();

  if (this.lpFilters == null)
    this.lpFilters = new Array();

  if (this.lpFilterPostGains == null)
    this.lpFilterPostGains = new Array();

  if (this.bandAnalysers == null)
    this.bandAnalysers = new Array();

  
  if (this.carrierBands == null)
    this.carrierBands = new Array();

  if (this.carrierFilterPostGains == null)
    this.carrierFilterPostGains = new Array();

  if (this.carrierBandGains == null)
    this.carrierBandGains = new Array();

    var waveShaperCurve = new Float32Array(65536);
  // Populate with a "curve" that does an abs()
    var n = 65536;
    var n2 = n / 2;
    
    for (var i = 0; i < n2; ++i) {
        x = i / n2;
        
        waveShaperCurve[n2 + i] = x;
        waveShaperCurve[n2 - i - 1] = x;
    }
  
  // Set up a high-pass filter to add back in the fricatives, etc.
  // (this isn't used by default in the "production" version, as I hid the slider)
  var hpFilter = this.audioContext.createBiquadFilter();
  hpFilter.type = "highpass";
  hpFilter.frequency.value = 8000; // or use vocoderBands[this.numVocoderBands-1].frequency;
  hpFilter.Q.value = 1; //  no peaking
  this.modulatorInput.connect( hpFilter);

  this.hpFilterGain = this.audioContext.createGain();
  this.hpFilterGain.gain.value = 0.0;

  hpFilter.connect( this.hpFilterGain );
  this.hpFilterGain.connect(this.audioContext.destination );

  //clear the arrays
  this.modFilterBands.length = 0;
  this.modFilterPostGains.length = 0;
  this.heterodynes.length = 0;
  this.powers.length = 0;
  this.lpFilters.length = 0;
  this.lpFilterPostGains.length = 0;
  this.carrierBands.length = 0;
  this.carrierFilterPostGains.length = 0;
  this.carrierBandGains.length = 0;
  this.bandAnalysers.length = 0;

  var outputGain = this.audioContext.createGain();
  outputGain.gain.value = 1
  outputGain.connect(compressor);

  var rectifierCurve = new Float32Array(65536);
  for (var i=-32768; i<32768; i++)
    rectifierCurve[i+32768] = ((i>0)?i:-i)/32768;

  for (var i=0; i<this.numVocoderBands; i++) {
    // CREATE THE MODULATOR CHAIN
    // create the bandpass filter in the modulator chain
    var modulatorFilter = this.audioContext.createBiquadFilter();
    modulatorFilter.type = "bandpass";  // Bandpass filter
    modulatorFilter.frequency.value = this.vocoderBands[i].frequency;
    modulatorFilter.Q.value = this.FILTER_QUALITY; //  initial quality
    this.modulatorInput.connect( modulatorFilter );
    this.modFilterBands.push( modulatorFilter );

    // Now, create a second bandpass filter tuned to the same frequency - 
    // this turns our second-order filter into a 4th-order filter,
    // which has a steeper rolloff/octave
    var secondModulatorFilter = this.audioContext.createBiquadFilter();
    secondModulatorFilter.type = "bandpass";  // Bandpass filter
    secondModulatorFilter.frequency.value = this.vocoderBands[i].frequency;
    secondModulatorFilter.Q.value = this.FILTER_QUALITY; //  initial quality
    modulatorFilter.chainedFilter = secondModulatorFilter;
    modulatorFilter.connect( secondModulatorFilter );

    // create a post-filtering gain to bump the levels up.
    var modulatorFilterPostGain = this.audioContext.createGain();
    modulatorFilterPostGain.gain.value = 8;
    secondModulatorFilter.connect( modulatorFilterPostGain );
    this.modFilterPostGains.push( modulatorFilterPostGain );

    // Create the sine oscillator for the heterodyne
    var heterodyneOscillator = this.audioContext.createOscillator();
    heterodyneOscillator.frequency.value = this.vocoderBands[i].frequency;

    heterodyneOscillator.start(0);

    // Create the node to multiply the sine by the modulator
    var heterodyne = this.audioContext.createGain();
    modulatorFilterPostGain.connect( heterodyne );
    heterodyne.gain.value = 0.0;  // audio-rate inputs are summed with initial intrinsic value
    heterodyneOscillator.connect( heterodyne.gain );

    var heterodynePostGain = this.audioContext.createGain();
    heterodynePostGain.gain.value = 2.0;    // GUESS:  boost
    heterodyne.connect( heterodynePostGain );
    this.heterodynes.push( heterodynePostGain );


    // Create the rectifier node
    var rectifier = this.audioContext.createWaveShaper();
    rectifier.curve = rectifierCurve;
    heterodynePostGain.connect( rectifier );

    // Create the lowpass filter to mask off the difference (near zero)
    var lpFilter = this.audioContext.createBiquadFilter();
    lpFilter.type = "lowpass";  // Lowpass filter
    lpFilter.frequency.value = 5.0; // Guesstimate!  Mask off 20Hz and above.
    lpFilter.Q.value = 1; // don't need a peak
    this.lpFilters.push( lpFilter );
    rectifier.connect( lpFilter );

    var lpFilterPostGain = this.audioContext.createGain();
    lpFilterPostGain.gain.value = 1.0; 
    lpFilter.connect( lpFilterPostGain );
    this.lpFilterPostGains.push( lpFilterPostGain );

    var waveshaper = this.audioContext.createWaveShaper();
    waveshaper.curve = waveShaperCurve;
    lpFilterPostGain.connect( waveshaper );

    // create an analyser to drive the vocoder band drawing
    var analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 128; //small, shouldn't matter
    waveshaper.connect(analyser);
    this.bandAnalysers.push( analyser );

    // Create the bandpass filter in the carrier chain
    var carrierFilter = this.audioContext.createBiquadFilter();
    carrierFilter.type = "bandpass";
    carrierFilter.frequency.value = this.vocoderBands[i].frequency;
    carrierFilter.Q.value = this.FILTER_QUALITY;
    this.carrierBands.push( carrierFilter );
    this.carrierInput.connect( carrierFilter );

    // We want our carrier filters to be 4th-order filter too.
    var secondCarrierFilter = this.audioContext.createBiquadFilter();
    secondCarrierFilter.type = "bandpass";  // Bandpass filter
    secondCarrierFilter.frequency.value = this.vocoderBands[i].frequency;
    secondCarrierFilter.Q.value = this.FILTER_QUALITY; //  initial quality
    carrierFilter.chainedFilter = secondCarrierFilter;
    carrierFilter.connect( secondCarrierFilter );

    var carrierFilterPostGain = this.audioContext.createGain();
    carrierFilterPostGain.gain.value = 10.0;
    secondCarrierFilter.connect( carrierFilterPostGain );
    this.carrierFilterPostGains.push( carrierFilterPostGain );

    // Create the carrier band gain node
    var bandGain = this.audioContext.createGain();
    this.carrierBandGains.push( bandGain );
    carrierFilterPostGain.connect( bandGain );
    bandGain.gain.value = 0.0;  // audio-rate inputs are summed with initial intrinsic value
    waveshaper.connect( bandGain.gain );  // connect the lp controller

    bandGain.connect( outputGain );
  }




  // Now set up our this.wavetable stuff.
  var real = new Float32Array(this.FOURIER_SIZE);
  var imag = new Float32Array(this.FOURIER_SIZE);
  real[0] = 0.0;
  imag[0] = 0.0;
  for (var i=1; i<this.FOURIER_SIZE; i++) {
    real[i]=1.0;
    imag[i]=1.0;
  }

  this.wavetable = (this.audioContext.createPeriodicWave) ?
    this.audioContext.createPeriodicWave(real, imag) :
    this.audioContext.createWaveTable(real, imag);
  this.loadNoiseBuffer();
}
Vocoder.prototype.setupVocoderGraph = function() {
  this.initBandpassFilters();
}
Vocoder.prototype.createCarriersAndPlay = function( output,freq ) {
  var self = this;
  this.carrierSampleNode = this.audioContext.createBufferSource();
  this.carrierSampleNode.buffer = this.carrierBuffer;
  this.carrierSampleNode.loop = true;

  this.carrierSampleGain = this.audioContext.createGain();
  this.carrierSampleGain.gain.value = this.carrierSampleGainValue;
  this.carrierSampleNode.connect( this.carrierSampleGain );
  this.carrierSampleGain.connect( output );

  // The this.wavetable signal needs a boost.
  this.wavetableSignalGain = this.audioContext.createGain();

  this.oscillatorNode = this.audioContext.createOscillator();
  if (this.oscillatorType = 4) { // this.wavetable
    self.oscillatorNode.setPeriodicWave ? 
    self.oscillatorNode.setPeriodicWave(self.wavetable) :
    self.oscillatorNode.setWaveTable(self.wavetable);
    self.wavetableSignalGain.gain.value = self.WAVETABLEBOOST;
  } else {
    self.oscillatorNode.type = self.oscillatorType;
    self.wavetableSignalGain.gain.value = self.SAWTOOTHBOOST;
  }
  this.oscillatorNode.frequency.value = freq;
  this.oscillatorNode.detune.value = this.oscillatorDetuneValue;
  this.oscillatorNode.connect(this.wavetableSignalGain);

  this.oscillatorGain = this.audioContext.createGain();
  this.oscillatorGain.gain.value = this.oscillatorGainValue;

  this.wavetableSignalGain.connect(this.oscillatorGain);
  this.oscillatorGain.connect(output);
  
  this.noiseNode = this.audioContext.createBufferSource();
  this.noiseNode.buffer = this.noiseBuffer;
  this.noiseNode.loop = true;
  this.noiseGain = this.audioContext.createGain();
  this.noiseGain.gain.value = this.noiseGainValue;
  this.noiseNode.connect(this.noiseGain);

  this.noiseGain.connect(output);
  this.oscillatorNode.start(0);
  this.noiseNode.start(0);
  this.carrierSampleNode.start(0);
}
Vocoder.prototype.vocode = function(freq) {
  if (this.event) 
    this.event.preventDefault();

  if (this.vocoding) {
    if (this.modulatorNode)
      this.modulatorNode.stop(0);
    this.shutOffCarrier();
    this.vocoding = false;
    //this.cancelVocoderUpdates();
   // if (endOfModulatorTimer)
    //  window.clearTimeout(endOfModulatorTimer);
    //endOfModulatorTimer = 0;
    //return;
  } 
  this.createCarriersAndPlay( this.carrierInput,freq );

  this.vocoding = true;

  this.modulatorNode = this.audioContext.createBufferSource();
  this.modulatorNode.buffer = this.modulatorBuffer;
  this.modulatorGain = this.audioContext.createGain();
  this.modulatorGain.gain.value = this.modulatorGainValue;
  this.modulatorNode.connect( this.modulatorGain );
  this.modulatorGain.connect( this.modulatorInput );

  this.modulatorNode.start(0);

  
  //endOfModulatorTimer = window.setTimeout( this.vocode, this.modulatorNode.buffer.duration * 1000 + 20 );
}
Vocoder.prototype.error = function() {
    alert('Stream generation failed.');
}
Vocoder.prototype.convertToMono = function( input ) {
    var splitter = this.audioContext.createChannelSplitter(2);
    var merger = this.audioContext.createChannelMerger(2);

    input.connect( splitter );
    splitter.connect( merger, 0, 0 );
    splitter.connect( merger, 0, 1 );
    return merger;
}
Vocoder.prototype.generateNoiseFloorCurve = function( floor ) {
    // "floor" is 0...1

    var curve = new Float32Array(65536);
    var mappedFloor = floor * 32768;

    for (var i=0; i<32768; i++) {
        var value = (i<mappedFloor) ? 0 : 1;

        curve[32768-i] = -value;
        curve[32768+i] = value;
    }
    curve[0] = curve[1]; // fixing up the end.

    return curve;
}
Vocoder.prototype.createNoiseGate = function( connectTo ) {
    var inputNode = this.audioContext.createGain();
    var rectifier = this.audioContext.createWaveShaper();
    var ngFollower = this.audioContext.createBiquadFilter();
    ngFollower.type = ngFollower.LOWPASS;
    ngFollower.frequency.value = 10.0;

    var curve = new Float32Array(65536);
    for (var i=-32768; i<32768; i++)
        curve[i+32768] = ((i>0)?i:-i)/32768;
    rectifier.curve = curve;
    rectifier.connect(ngFollower);

    var ngGate = this.audioContext.createWaveShaper();
    ngGate.curve = this.generateNoiseFloorCurve(0.01);

    ngFollower.connect(ngGate);

    var gateGain = this.audioContext.createGain();
    gateGain.gain.value = 0.0;
    ngGate.connect( gateGain.gain );

    gateGain.connect( connectTo );

    inputNode.connect(rectifier);
    inputNode.connect(gateGain);
    return inputNode;
}

// this is ONLY because we have massive feedback without filtering out
// the top end in live speaker scenarios.
Vocoder.prototype.createLPInputFilter = function(output) {
  this.lpInputFilter = this.audioContext.createBiquadFilter();
  this.lpInputFilter.connect(output);
  this.lpInputFilter.frequency.value = 2048;
  return this.lpInputFilter;
}
Vocoder.prototype.shutOffCarrier = function() {
  this.oscillatorNode.stop(0);
  this.oscillatorNode = null;
  this.noiseNode.stop(0);
  this.noiseNode = null;
  this.carrierSampleNode.stop(0);
  this.carrierSampleNode = null;
}




  // Initialization function for the page.
Vocoder.prototype.init = function(ctx) {
  this.audioContext = ctx;
  this.generateVocoderBands(55, 7040, 28);
  this.setupVocoderGraph();
}
Vocoder.prototype.changeParams = function(carrierB, modulatorB,freq){
  this.carrierBuffer = carrierB;
  this.modulatorBuffer = modulatorB;
  this.vocode(freq);
}
    
 


