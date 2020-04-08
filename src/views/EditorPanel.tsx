import React from "react";
import ReactDOM from "react-dom";
import { ThemeProvider } from "@material-ui/styles";
import "./editor/index";
import { crossnoteTheme } from "./util/theme";
import "./index.less";

import Editor from "./components/Editor";

import "typeface-roboto";
import "typeface-noto-sans-sc";

ReactDOM.render(
  <ThemeProvider theme={crossnoteTheme}>
    <Editor></Editor>
  </ThemeProvider>,

  document.getElementById("root")
);
