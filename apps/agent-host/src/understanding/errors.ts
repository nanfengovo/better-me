export class UnderstandingError extends Error {
  constructor(readonly code:string,message:string,readonly status=400,readonly recoverable=true){super(message);this.name="UnderstandingError";}
}
