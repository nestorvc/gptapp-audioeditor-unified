/**
 * Type declarations for essentia.js
 */
declare module "essentia.js" {
  export interface EssentiaWASMModule {
    (): Promise<any>;
  }

  export interface EssentiaInstance {
    arrayToVector(inputArray: Float32Array): any;
    vectorToArray(inputVector: any): Float32Array;
    RhythmExtractor2013(
      signal: any,
      maxTempo?: number,
      method?: string,
      minTempo?: number
    ): {
      bpm: number;
      ticks: number[];
      confidence: number;
      estimates: number[];
      bpmIntervals: number[];
    };
    KeyExtractor(
      audio: any,
      averageDetuningCorrection?: boolean,
      frameSize?: number,
      hopSize?: number,
      hpcpSize?: number,
      maxFrequency?: number,
      maximumSpectralPeaks?: number,
      minFrequency?: number,
      pcpThreshold?: number,
      profileType?: string,
      sampleRate?: number,
      spectralPeaksThreshold?: number,
      tuningFrequency?: number,
      weightType?: string,
      windowType?: string
    ): {
      key: string;
      scale: string;
      strength: number;
    };
  }

  export interface EssentiaConstructor {
    new (essentiaWASM: any, isDebug?: boolean): EssentiaInstance;
  }

  export const EssentiaWASM: EssentiaWASMModule;
  export const Essentia: EssentiaConstructor;
}

