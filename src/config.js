// Core tuning values for Sky Rush.

// The flight area is a 3x3 grid of cells.
// Row centres (y), top -> bottom. Index 1 is the neutral middle row.
export const LANES = [2.5, 0, -2.5];
// Column centres (x), left -> right. Index 1 is the neutral centre column.
export const COLS = [-2.1, 0, 2.1];
// Half-height / half-width of an obstacle that blocks one cell.
export const BAND = 1.05;
export const BAND_X = 1.0;
// Half extents of the player's hit box (forgiving vs. the visual model).
export const PLAYER_HALF_X = 0.42;
export const PLAYER_HALF_Y = 0.42;
export const PLAYER_HALF_Z = 0.45;

// How far ahead of the player the track is generated.
export const SPAWN_AHEAD = 175;
// Things further behind the player than this are recycled.
export const DESPAWN_BEHIND = 12;

export const BASE_SPEED = 20;
export const MAX_SPEED = 55;
export const BOOST_MULT = 1.8;

// Shields have no timer: they last until they absorb a hit. Up to two can stack.
export const POWER_TIME = { magnet: 10, boost: 5 };
export const MAX_SHIELDS = 2;

// Forward speed grows quickly at first, then levels off.
export function speedAt(dist) {
  return BASE_SPEED + (MAX_SPEED - BASE_SPEED) * (1 - Math.exp(-dist / 2600));
}

// 0 -> 1 difficulty ramp used by the track generator.
export function difficultyAt(dist) {
  return Math.min(1, dist / 5000);
}
