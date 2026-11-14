import { audioToText } from "./transcribe.ai"

export const transcribeUpload=async(file:Express.Multer.File)=>{
    return audioToText(file);
}