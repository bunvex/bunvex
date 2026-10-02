// Where the mock's visitors come from: cities with their coordinates, and a weight (how often a session starts
// there). A real source places sessions by GeoIP; these are for the mock and the tests only.
import type { Place } from "./data-source.ts";

export const PLACES: (Place & { weight: number })[] = [
  { city: "São Paulo", country: "Brazil", countryCode: "BR", lat: -23.55, lon: -46.63, weight: 9 },
  { city: "Rio de Janeiro", country: "Brazil", countryCode: "BR", lat: -22.91, lon: -43.17, weight: 4 },
  { city: "Belo Horizonte", country: "Brazil", countryCode: "BR", lat: -19.92, lon: -43.94, weight: 2 },
  { city: "Curitiba", country: "Brazil", countryCode: "BR", lat: -25.43, lon: -49.27, weight: 2 },
  { city: "Buenos Aires", country: "Argentina", countryCode: "AR", lat: -34.6, lon: -58.38, weight: 2 },
  { city: "Santiago", country: "Chile", countryCode: "CL", lat: -33.45, lon: -70.67, weight: 1 },
  { city: "Mexico City", country: "Mexico", countryCode: "MX", lat: 19.43, lon: -99.13, weight: 2 },
  { city: "New York", country: "United States", countryCode: "US", lat: 40.71, lon: -74.01, weight: 6 },
  { city: "San Francisco", country: "United States", countryCode: "US", lat: 37.77, lon: -122.42, weight: 5 },
  { city: "Austin", country: "United States", countryCode: "US", lat: 30.27, lon: -97.74, weight: 2 },
  { city: "Toronto", country: "Canada", countryCode: "CA", lat: 43.65, lon: -79.38, weight: 2 },
  { city: "London", country: "United Kingdom", countryCode: "GB", lat: 51.51, lon: -0.13, weight: 5 },
  { city: "Berlin", country: "Germany", countryCode: "DE", lat: 52.52, lon: 13.4, weight: 4 },
  { city: "Paris", country: "France", countryCode: "FR", lat: 48.86, lon: 2.35, weight: 3 },
  { city: "Amsterdam", country: "Netherlands", countryCode: "NL", lat: 52.37, lon: 4.9, weight: 2 },
  { city: "Lisbon", country: "Portugal", countryCode: "PT", lat: 38.72, lon: -9.14, weight: 2 },
  { city: "Madrid", country: "Spain", countryCode: "ES", lat: 40.42, lon: -3.7, weight: 2 },
  { city: "Stockholm", country: "Sweden", countryCode: "SE", lat: 59.33, lon: 18.07, weight: 1 },
  { city: "Istanbul", country: "Türkiye", countryCode: "TR", lat: 41.01, lon: 28.98, weight: 1 },
  { city: "Lagos", country: "Nigeria", countryCode: "NG", lat: 6.52, lon: 3.38, weight: 1 },
  { city: "Cape Town", country: "South Africa", countryCode: "ZA", lat: -33.92, lon: 18.42, weight: 1 },
  { city: "Bengaluru", country: "India", countryCode: "IN", lat: 12.97, lon: 77.59, weight: 4 },
  { city: "Mumbai", country: "India", countryCode: "IN", lat: 19.08, lon: 72.88, weight: 3 },
  { city: "Singapore", country: "Singapore", countryCode: "SG", lat: 1.35, lon: 103.82, weight: 2 },
  { city: "Tokyo", country: "Japan", countryCode: "JP", lat: 35.68, lon: 139.69, weight: 3 },
  { city: "Seoul", country: "South Korea", countryCode: "KR", lat: 37.57, lon: 126.98, weight: 2 },
  { city: "Ho Chi Minh City", country: "Vietnam", countryCode: "VN", lat: 10.82, lon: 106.63, weight: 1 },
  { city: "Sydney", country: "Australia", countryCode: "AU", lat: -33.87, lon: 151.21, weight: 2 },
];
