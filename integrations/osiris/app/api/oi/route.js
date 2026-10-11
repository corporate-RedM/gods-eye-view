// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
import { describe, disabled, disabledResponse, json, siteOrigin } from '../../../lib/oi/service.js';
/**
 * OSIRIS OI — what the service offers: providers, depths, limits, endpoints.
 * GET /api/oi
 */
export const dynamic = 'force-dynamic';
export async function GET(req) {
    if (disabled())
        return disabledResponse();
    return json(describe(siteOrigin(req)));
}
