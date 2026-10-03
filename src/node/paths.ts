/**
 * Git Bash (MSYS) turns an argument like /faq into C:/Program Files/Git/faq. Returns the path as it
 * was typed, so nobody has to remember MSYS_NO_PATHCONV.
 */
export const fromGitBashPath = (arg: string): string =>
    arg.match(/^[A-Za-z]:\/(?:[^?]*?\/)?Git(\/.*)$/)?.[1] ?? arg;
