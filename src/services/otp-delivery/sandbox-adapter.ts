import { logger } from '../../config/logger';
import { maskPhone } from '../../shared/phone-identity';
import type { OtpMessage, OtpProvider, OtpSendResult } from './types';

// ---------------------------------------------------------------------------
// The QA sandbox. Sends nothing: it writes the code to the server console, at
// debug level, so a developer can complete the flow. It is the ONLY place a
// code is ever written anywhere, and index.ts refuses it outside a
// development / test server.
// ---------------------------------------------------------------------------

export function createOtpSandboxProvider(): OtpProvider {
  return {
    name: 'sandbox',
    sandbox: true,
    async send(message: OtpMessage): Promise<OtpSendResult> {
      logger.debug(
        { sandbox: true, to: maskPhone(message.to), code: message.code },
        'SANDBOX one-time code - not sent to any phone',
      );
      return { status: 'sent', channel: 'sms', provider: 'sandbox', sandbox: true, error: null };
    },
  };
}
