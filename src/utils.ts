import axios from "axios";

export async function pollHeartbeat() {
    try {
        await axios.get(process.env.HEARTBEAT);
    } catch(err) {
        console.error(`heartbeat`, err);
    }
}