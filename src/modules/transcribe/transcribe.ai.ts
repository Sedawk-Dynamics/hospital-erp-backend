import dotenv from 'dotenv';
dotenv.config();

type TranscriptionResponse = {
    text?: string;
    error?: { code?: string | number; message?: string };
};

export const audioToText = async (file: Express.Multer.File) => {
    console.log('[transcribe] audioToText called', {
        size: file?.size,
        mimetype: file?.mimetype,
        hasApiKey: !!process.env.OPENROUTER_API_KEY,
    });
    const base64Audio = file.buffer.toString('base64');

    const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "openai/whisper-large-v3",
            input_audio: {
                data: base64Audio,
                format: "webm",
            },
        }),
    });

    const result = await response.json() as TranscriptionResponse;

    // Surface the real failure instead of silently returning an empty string.
    if (!response.ok || result.error || !result.text) {
        console.error('OpenRouter transcription failed', {
            status: response.status,
            body: result,
        });
        throw new Error(result.error?.message || `Transcription failed (${response.status})`);
    }

    return result.text;
}
