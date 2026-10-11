// Adapted from OSIRIS (MIT), commit 83b8cd1. See docs/OSIRIS-NOTICE.md.
/**
 * A run's state, folded out of its events. The server keeps one per run for
 * snapshots; the panel keeps its own from the same stream.
 */
import { answerText } from './forecast.js';
export function initialState() {
    return {
        status: 'running',
        question: '',
        depth: 'standard',
        provider: '',
        model: '',
        actorsPlanned: 0,
        periodsPlanned: 0,
        worldsPlanned: 0,
        phase: 'context',
        phaseLabel: '',
        context: [],
        frame: null,
        quant: null,
        actors: [],
        links: [],
        periods: [],
        worlds: [],
        moves: [],
        events: [],
        points: [],
        rounds: [],
        injects: [],
        report: null,
        usage: { calls: 0, input: 0, output: 0 },
        warnings: [],
        message: '',
        thinking: {},
        startedAt: 0,
        updatedAt: 0,
        endedAt: 0,
        steps: [],
        lastSeq: -1,
    };
}
/** The next state. Returns a new object, and leaves `s` untouched. Replayed events (seq already seen) are ignored. */
export function applyEvent(s, e) {
    if (e.seq <= s.lastSeq)
        return s;
    const n = { ...s, lastSeq: e.seq, updatedAt: e.at };
    switch (e.t) {
        case 'start':
            n.question = e.question;
            n.depth = e.depth;
            n.provider = e.provider;
            n.model = e.model;
            n.actorsPlanned = e.actors;
            n.periodsPlanned = e.periods;
            n.worldsPlanned = e.worlds;
            n.startedAt = e.at;
            break;
        case 'phase':
            n.phase = e.phase;
            n.phaseLabel = e.label;
            n.steps = [...s.steps, { phase: e.phase, label: e.label, at: e.at }];
            break;
        case 'context':
            n.context = e.items;
            break;
        case 'frame':
            n.frame = e.frame;
            break;
        case 'quant':
            n.quant = e.quant;
            break;
        case 'actor':
            n.actors = [...s.actors, e.actor];
            break;
        case 'cast':
            n.actors = s.actors.map(a => (a.id === e.actor ? { ...a, persona: e.persona } : a));
            break;
        case 'clock':
            n.periods = e.periods;
            n.worlds = e.worlds;
            break;
        case 'link': {
            // A link drawn again (an actor pressing the same rival) replaces the old one and is reborn, so it re-animates.
            const i = s.links.findIndex(l => l.id === e.link.id);
            n.links = i < 0 ? [...s.links, e.link] : [...s.links.slice(0, i), ...s.links.slice(i + 1), e.link];
            break;
        }
        case 'thinking':
            n.thinking = { ...s.thinking, [`${e.world}:${e.actor}`]: e.period };
            break;
        case 'move': {
            n.moves = [...s.moves, e.move];
            const thinking = { ...s.thinking };
            delete thinking[`${e.move.world}:${e.move.actor}`];
            n.thinking = thinking;
            break;
        }
        case 'event':
            n.events = [...s.events, e.event];
            break;
        case 'point':
            n.points = [...s.points, e.point];
            break;
        case 'round':
            n.rounds = [...s.rounds, e.stat];
            n.thinking = {};
            break;
        case 'inject':
            n.injects = [...s.injects, { text: e.text, round: e.round }];
            break;
        case 'report':
            n.report = e.report;
            break;
        case 'usage':
            n.usage = e.usage;
            break;
        case 'warn':
            n.warnings = [...s.warnings, e.message].slice(-20);
            break;
        case 'end':
            n.status = e.status;
            n.message = e.message || '';
            n.thinking = {};
            n.endedAt = e.at;
            if (e.status === 'done') {
                n.phase = 'done';
                n.phaseLabel = 'Prediction ready';
            }
            break;
    }
    return n;
}
/** The headline probability at this point in the run: a yes/no question's P(YES), a choice's leader share. None for a number. */
export function currentProbability(s) {
    if (s.frame?.kind === 'number')
        return null;
    if (s.report)
        return s.report.probability;
    const last = s.rounds[s.rounds.length - 1];
    return last ? last.consensus : null;
}
/** The answer so far, in a phrase: the report's once written, else the worlds' pool after the last period. */
export function currentAnswer(s) {
    return answerText(s.frame, s.report, s.rounds[s.rounds.length - 1] ?? null);
}
/** The actors cast to play, in the order they were cast. */
export const castOf = (s) => s.actors.filter(a => a.persona);
/** Each world's latest point. */
export function latestPoints(s) {
    const out = new Map();
    for (const p of s.points)
        out.set(p.world, p);
    return out;
}
/** "World A" */
export const worldName = (w) => `World ${w}`;
