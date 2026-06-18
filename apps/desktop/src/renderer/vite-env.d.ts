/// <reference types="vite/client" />

declare module "*.ts?url" {
  const url: string;
  export default url;
}
