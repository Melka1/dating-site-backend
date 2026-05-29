import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'raw_response';

/**
 * Opt a handler out of the global TransformInterceptor envelope.
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
