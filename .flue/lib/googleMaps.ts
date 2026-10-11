// The one Google Maps Platform key (Places, Routes, Weather, Air Quality).
// Restrict it in the console to the APIs these tools call.

export const googleMapsConfigured = (): boolean => Boolean(process.env.GOOGLE_MAPS_API_KEY);

export const googleMapsKey = (): string => {
  const k = process.env.GOOGLE_MAPS_API_KEY;
  if (!k) throw new Error("GOOGLE_MAPS_API_KEY not set");
  return k;
};
