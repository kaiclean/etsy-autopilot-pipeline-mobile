import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("Add these to the server environment. Do not commit them.\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
