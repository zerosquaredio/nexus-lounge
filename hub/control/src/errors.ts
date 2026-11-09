//  An error whose message is meant for the person running the hub
export class HubError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'HubError';
        this.code = code;
    }
}
