/**
 * The voice session's tools for the standalone server: the app actions plus
 * the catalog tools voice offers (see src/tools/surfaces.js), which the
 * browser runs through the same catalog.
 */

import {
  coreTools,
  toFunctionTools,
  toolsForSurface,
} from '../../src/tools/index.js';
import { realtimeSessionTools } from '../providers/openai/tools.js';
import { eyeTools } from '../../src/standalone/eyeTools.js';

export function standaloneVoiceTools() {
  return realtimeSessionTools(
    toFunctionTools(toolsForSurface([...coreTools, ...eyeTools], 'voice')),
  );
}
