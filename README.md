# Google Earth 3D Tiles Viewer

This project demonstrates how to use the 3D Tiles Renderer library with Google Maps Platform to display photorealistic 3D tiles of the Earth.

## Setup

1. Get a Google Maps JavaScript API key:
   - Sign up for a Google Cloud account at [https://cloud.google.com/](https://cloud.google.com/)
   - Create a new project and enable the Google Maps JavaScript API
   - Create an API key with appropriate restrictions

2. Update your API key:
   - Create a `.env` file in the project root if it doesn't exist
   - Add your Google Maps JavaScript API key as follows:
     ```
     VITE_GOOGLE_MAPS_JS_API_KEY=your_google_maps_js_api_key_here
     ```

## Development

```bash
# Install dependencies
npm install

# Start the development server
npm run dev
```

## Features

- Photorealistic 3D globe using Google Maps Platform's 3D Tiles
- Globe controls for navigation
- Camera transitions between perspective and orthographic views
- Performance statistics display
- URL hash-based navigation
- Custom location controls with precise positioning

## Controls

- Left-click and drag to rotate the globe
- Right-click and drag to pan
- Scroll to zoom in/out
- Use the GUI panel to toggle between perspective and orthographic views
- Use the location controls to navigate to specific coordinates

## Notes

This application requires a valid Google Maps JavaScript API key with access to the Google Photorealistic 3D Tiles. Be aware that usage of the Google Maps Platform APIs may incur charges according to Google's pricing policy.
