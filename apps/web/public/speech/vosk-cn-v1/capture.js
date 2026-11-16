// The context resamples input to 16 kHz mono. This processor outputs silence,
// never connects the microphone to the speaker, and sends no network messages.
class InventoryMono extends AudioWorkletProcessor {
  constructor(){super();this.block=new Float32Array(2048);this.offset=0;this.ended=false;
    this.port.onmessage=({data})=>{if(data!=="finish"||this.ended)return;this.ended=true;
      if(this.offset){const tail=this.block.slice(0,this.offset);this.port.postMessage(tail,[tail.buffer]);}
      this.port.postMessage("drained");};
  }
  process(inputs){
    if(this.ended)return false;
    const samples=inputs[0]?.[0];if(!samples)return true;
    for(const value of samples){
      this.block[this.offset++]=value;
      if(this.offset===this.block.length){
        this.port.postMessage(this.block,[this.block.buffer]);this.block=new Float32Array(2048);this.offset=0;
      }
    }
    return true;
  }
}
registerProcessor("betterme-inventory-mono",InventoryMono);
