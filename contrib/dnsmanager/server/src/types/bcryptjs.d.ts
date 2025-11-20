declare module "bcryptjs" {
  export function compare(data: string, encrypted: string): Promise<boolean>;
}
