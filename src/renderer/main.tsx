import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import "antd/dist/reset.css";
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#355df4",
          borderRadius: 10,
          fontFamily:
            '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          colorBgLayout: "#f5f6fa",
          colorText: "#202738",
        },
        components: {
          Button: { controlHeight: 38 },
          Input: { controlHeight: 40 },
          Select: { controlHeight: 40 },
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
