# Deriv Analytics

Real-time digit distribution and tick-direction views powered by Deriv's public WebSocket market data.

## Run locally

```sh
npm install
npm start
```

The server listens on the port provided by the environment, or port 5000 by default.

## Data and accuracy

Digit values are read from the last character of the quote string at Deriv's `pip_size` precision. When the API omits trailing zeroes from its numeric JSON quotes, the server pads those zeroes without changing the quote value. The dashboard does not use a Deriv-provided last-digit field. The Rise & Fall view is a momentum visualizer, not a prediction tool. Deriv volatility indices are randomly generated, and the momentum threshold defaults to 65% (configurable in the client code); it is an observational signal, not a guarantee of outcomes.

## Deriv API references

- [Deriv API documentation](https://developers.deriv.com/docs/)
- [Deriv API LLMs reference](https://developers.deriv.com/llms.txt)
- [Getting Started guide](https://developers.deriv.com/llms/getting-started.md)
- [Ticks History endpoint](https://developers.deriv.com/llms/ticks-history.md)
- [Ticks Stream endpoint](https://developers.deriv.com/llms/ticks.md)
- [WebSocket public endpoint](https://developers.deriv.com/llms/ws-public.md)
- [Error handling](https://developers.deriv.com/llms/errors.md)
- [Deriv API Playground](https://developers.deriv.com/playground)
- Deriv API support: api-support@deriv.com