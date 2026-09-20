/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dev overlay badge sits bottom-left, exactly on top of the chord diagram.
  devIndicators: false,
  images: {
    // Spotify serves album art from these CDNs.
    remotePatterns: [{ protocol: "https", hostname: "i.scdn.co" }],
  },
};

export default nextConfig;
