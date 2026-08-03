import { Injectable } from "@nestjs/common";

export const MESSAGE_TRANSPORT = Symbol("MESSAGE_TRANSPORT");

export interface MessageTransport {
  send(messageLogId: string): Promise<void>;
}

// Compose-&-log: the message row IS the deliverable; nothing is transmitted (Design §1, §17.3).
@Injectable()
export class LogTransport implements MessageTransport {
  async send(_messageLogId: string): Promise<void> {
    // no-op until SmtpTransport lands at the go-live gate.
  }
}
