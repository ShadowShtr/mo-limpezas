/**
 * Haversine distance between two GPS coordinates, in metres.
 */
export function haversineDistanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Service value: (durationMinutes / 60) × hourlyRate × numCollaborators.
 */
export function calcServiceValue(
  durationMinutes: number,
  hourlyRate: number,
  numCollaborators: number
): number {
  return parseFloat(((durationMinutes / 60) * hourlyRate * numCollaborators).toFixed(2));
}

/**
 * Monthly payroll gross: workedHours × hourlyRate + mealDays × mealAllowance.
 */
export function calcMonthlyGross(
  workedHours: number,
  hourlyRate: number,
  mealDays: number,
  mealAllowance: number
): number {
  return parseFloat((workedHours * hourlyRate + mealDays * mealAllowance).toFixed(2));
}

/**
 * Validate GPS coordinates.
 */
export function isValidCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}
