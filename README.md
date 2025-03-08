# Google Earth 3D Tiles Viewer

This project demonstrates how to use the 3D Tiles Renderer library with Cesium Ion to display photorealistic 3D tiles of the Earth.

## Setup

1. Get a Cesium Ion API key:
   - Sign up for a free account at [https://cesium.com/ion/signup/](https://cesium.com/ion/signup/)
   - Create a new token in your account settings
   - Copy the token

2. Update your API key:
   - Open the `.env` file
   - Replace `your_cesium_ion_api_key_here` with your actual Cesium Ion API key

## Development

```bash
# Install dependencies
npm install

# Start the development server
npm run dev
```

## Features

- Photorealistic 3D globe using Cesium Ion's 3D Tiles
- Globe controls for navigation
- Camera transitions between perspective and orthographic views
- Performance statistics display
- URL hash-based navigation

## Controls

- Left-click and drag to rotate the globe
- Right-click and drag to pan
- Scroll to zoom in/out
- Use the GUI panel to toggle between perspective and orthographic views

## Notes

This application requires a valid Cesium Ion API key with access to the Google Photorealistic 3D Tiles dataset (Asset ID: 2275207). The free tier of Cesium Ion includes access to this dataset with usage limitations.
# google-earth
