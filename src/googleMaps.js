import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

let mapsLibrariesPromise = null;

function getGoogleMapsApiKey() {
  return import.meta.env.VITE_GOOGLE_MAPS_JS_API_KEY;
}

function configureGoogleMapsLoader() {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    throw new Error("Missing VITE_GOOGLE_MAPS_JS_API_KEY for route controls.");
  }

  setOptions({
    key: apiKey,
    v: "weekly",
    libraries: ["places", "routes"],
  });
}

export function getMapsLibraries() {
  if (!mapsLibrariesPromise) {
    mapsLibrariesPromise = Promise.resolve().then(async () => {
      configureGoogleMapsLoader();

      const [{ AutocompleteSuggestion, AutocompleteSessionToken }, { Route }] =
        await Promise.all([
          importLibrary("places"),
          importLibrary("routes"),
        ]);

      return { AutocompleteSuggestion, AutocompleteSessionToken, Route };
    });
  }

  return mapsLibrariesPromise;
}
